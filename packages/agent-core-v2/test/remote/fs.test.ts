import { createHash } from 'node:crypto';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { readTextPage } from '#/os/operations/readTextPage';
import { TEXT_PAGE_MAX_REMOTE_CHARS, type TextPageOptions } from '#/os/interface/fileOperations';
import { mkdir, mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { HostFsError } from '#/os/interface/hostFsErrors';
import { HOST_WALK_MAX_IGNORE_BYTES } from '#/os/interface/hostFsWalk';

import { RemoteExecConnection } from '#/remote/client/connection';
import { RemoteFileSystem } from '#/os/backends/remote/remoteFileSystem';
import {
  FS_READ_DIRECTORY_MAX_ENTRIES,
  FS_READ_DIRECTORY_METHOD,
  FS_READ_FILE_WHOLE_MAX_BYTES,
  FS_WALK_METHOD,
} from '#/remote/protocol/methods';
import { RpcErrorCode } from '#/remote/protocol/errors';
import {
  connectInProcess,
  connectSubprocess,
  createInProcessLoopback,
  RawClient,
  type SpawnedExecutor,
} from './helpers/loopback';

describe('fs group over a subprocess loopback', () => {
  let connection: RemoteExecConnection;
  let spawned: SpawnedExecutor;
  let fs: RemoteFileSystem;
  let workDir: string;

  beforeAll(async () => {
    ({ connection, spawned } = await connectSubprocess());
    fs = new RemoteFileSystem(connection);
    workDir = await mkdtemp(join(tmpdir(), 'remote-exec-fs-'));
  }, 60_000);

  afterAll(async () => {
    connection.close();
    spawned.bridge.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('fetches exactly the requested sniff bytes', async () => {
    const path = join(workDir, 'sniff.txt');
    await writeFile(path, 'x'.repeat(2 * 1024 * 1024));
    const calls = vi.spyOn(connection, 'call');
    try {
      expect((await fs.readBytes(path, 512)).byteLength).toBe(512);
      expect(calls.mock.calls).toEqual([['fs/readFile', { path, offset: 0, maxBytes: 512 }]]);
      const reply = await calls.mock.results[0]!.value;
      expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(1024);
    } finally { calls.mockRestore(); }
  });

  it('reads a bounded page of a large file in one RPC', async () => {
    const path = join(workDir, 'page.txt');
    await writeFile(path, 'hello world\n'.repeat(1_000_000));
    const calls = vi.spyOn(connection, 'call');
    try {
      const result = await fs.operations.readTextPage(path, pageOptions(path, { n_lines: 3 }));
      expect(result.output).toBe('1\thello world\n2\thello world\n3\thello world');
      expect(result.note).toContain('Total lines in file: 1000000');
      expect(calls.mock.calls.map(([method]) => method)).toEqual(['fs/readTextPage']);
      expect(Buffer.byteLength(JSON.stringify(await calls.mock.results[0]!.value))).toBeLessThan(1024);
    } finally { calls.mockRestore(); }
  });

  it.each([
    ['crlf', Buffer.from('alpha\r\nbeta\r\ngamma\r\n')],
    ['mixed', Buffer.from('alpha\r\nbeta\ngam\rma')],
    ['utf16', Buffer.from('\uFEFFalpha\r\nbeta😀\r\ngamma', 'utf16le')],
    ['binary', Buffer.from('alpha\n\0beta')],
    ['long', Buffer.from('😀'.repeat(4000) + '\nlast\n')],
  ])('preserves local Read semantics for %s', async (name, bytes) => {
    const path = join(workDir, `${name}.txt`);
    await writeFile(path, bytes);
    const local = new HostFileSystem();
    const source = { name: path, stat: () => local.stat(path), readBytes: (n?: number) => local.readBytes(path, n), readLines: () => local.readLines(path, { errors: 'strict' }) };
    for (const args of [{ n_lines: 1 }, { line_offset: -2, n_lines: 1 }, { line_offset: -3 }, { column_offset: 2, n_lines: 1 }]) {
      const options = pageOptions(path, args);
      expect(await fs.operations.readTextPage(path, options)).toEqual(await readTextPage(source, options));
    }
  });

  it('preserves configured Read budgets larger than the remote page limit', async () => {
    const path = join(workDir, 'large-read-budget.txt');
    await writeFile(path, 'first\nsecond\n');
    const calls = vi.spyOn(connection, 'call');
    try {
      const options = { ...pageOptions(path), maxChars: TEXT_PAGE_MAX_REMOTE_CHARS + 1, maxCharsLimit: TEXT_PAGE_MAX_REMOTE_CHARS + 1 };
      expect((await fs.operations.readTextPage(path, options)).output).toBe('1\tfirst\n2\tsecond');
      expect(calls.mock.calls.some(([method]) => method === 'fs/readTextPage')).toBe(false);
      expect(calls.mock.calls.some(([method]) => method === 'fs/readFile')).toBe(true);
    } finally { calls.mockRestore(); }
  });

  it('keeps concurrent Read calls working above the executor scan limit', async () => {
    const path = join(workDir, 'concurrent-read.txt');
    await writeFile(path, 'first\nsecond\n');
    const calls = vi.spyOn(connection, 'call');
    try {
      const results = await Promise.all(Array.from({ length: 12 }, () => fs.operations.readTextPage(path, pageOptions(path))));
      expect(results.every((result) => !result.isError && result.output === '1\tfirst\n2\tsecond')).toBe(true);
      expect(calls.mock.calls.filter(([method]) => method === 'fs/readTextPage')).toHaveLength(8);
      expect(calls.mock.calls.some(([method]) => method === 'fs/readFile')).toBe(true);
    } finally { calls.mockRestore(); }
  });

  it('preserves Read and Edit error results when an operation RPC fails', async () => {
    const path = join(workDir, 'rpc-failure.txt');
    const calls = vi.spyOn(connection, 'call').mockRejectedValue(new Error('connection closed'));
    try {
      expect(await fs.operations.readTextPage(path, pageOptions(path))).toEqual({ isError: true, output: 'connection closed' });
      expect(await fs.operations.editText({ path, displayPath: 'rpc-failure.txt', old_string: 'old', new_string: 'new', replace_all: false })).toEqual({ ok: false, error: 'connection closed' });
    } finally { calls.mockRestore(); }
  });

  it('edits on the execution host without downloading or uploading the full file', async () => {
    const path = join(workDir, 'edit-page.txt');
    const before = 'a'.repeat(3 * 1024 * 1024) + '\r\nold value\r\n';
    await writeFile(path, before);
    const calls = vi.spyOn(connection, 'call');
    try {
      expect(await fs.operations.editText({ path, displayPath: 'edit-page.txt', old_string: 'old value', new_string: 'new value\nnext', replace_all: false })).toEqual({ ok: true, count: 1 });
      expect(calls.mock.calls.map(([method]) => method)).toEqual(['fs/editText']);
      expect(Buffer.byteLength(JSON.stringify(calls.mock.calls))).toBeLessThan(1024);
      expect(await readFile(path, 'utf8')).toBe(before.replace('old value', 'new value\r\nnext'));
      const failure = await fs.operations.editText({ path, displayPath: 'edit-page.txt', old_string: 'absent', new_string: '', replace_all: false });
      expect(failure.ok).toBe(false);
    } finally { calls.mockRestore(); }
  });

  it('creates the parent and writes text in a single RPC', async () => {
    const path = join(workDir, 'created', 'nested', 'out.txt');
    const calls = vi.spyOn(connection, 'call');
    try {
      const result = await fs.operations.writeText({ path, parent: join(workDir, 'created', 'nested'), displayPath: 'out.txt', content: 'hello', mode: 'overwrite' });
      expect(result).toEqual({ output: 'Wrote 5 bytes to out.txt' });
      expect(calls.mock.calls.map(([method]) => method)).toEqual(['fs/writeFile']);
      expect(await readFile(path, 'utf8')).toBe('hello');
    } finally { calls.mockRestore(); }
  });

  it('batches snapshots and skips bytes only for a matching content hash', async () => {
    const path = join(workDir, 'snapshot.txt');
    const bytes = Buffer.from('before');
    await writeFile(path, bytes);
    const knownHash = createHash('sha256').update(bytes).digest('hex');
    const calls = vi.spyOn(connection, 'call');
    try {
      const snapshots = await fs.operations.snapshotFiles([{ path, knownHash }, { path: join(workDir, 'missing-snapshot') }], 1024);
      expect(snapshots).toEqual([{ kind: 'file', contentHash: knownHash, bytes: undefined }, { kind: 'missing' }]);
      expect(calls.mock.calls.map(([method]) => method)).toEqual(['fs/snapshotFiles']);
      const stat = await fs.stat(path);
      await writeFile(path, 'after!');
      await utimes(path, new Date(), new Date(stat.mtimeMs!));
      const changed = (await fs.operations.snapshotFiles([{ path, knownHash }], 1024))[0]!;
      expect(changed.kind).toBe('file');
      if (changed.kind === 'file') expect(Buffer.from(changed.bytes!).toString()).toBe('after!');
      expect(await fs.operations.snapshotFiles([{ path }], 2)).toMatchObject([{ kind: 'oversize', size: 6 }]);
    } finally { calls.mockRestore(); }
  });

  it('discovers Git and instruction files without per-directory RPCs or stale negative caching', async () => {
    const root = join(workDir, 'probe');
    const nested = join(root, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });
    await mkdir(join(root, '.git'));
    await writeFile(join(root, 'AGENTS.md'), 'root instructions');
    const calls = vi.spyOn(connection, 'call');
    try {
      expect((await fs.operations.findGitWorkTree(nested))?.root).toBe(root);
      expect(await fs.operations.discoverInstructions([nested, join(nested, 'missing')], [])).toEqual([join(root, 'AGENTS.md')]);
      expect(calls.mock.calls.map(([method]) => method)).toEqual(['fs/findGitWorkTree', 'fs/discoverInstructions']);
      await writeFile(join(nested, 'AGENTS.md'), 'new instructions');
      expect(await fs.operations.discoverInstructions([nested], [join(root, 'AGENTS.md')])).toContain(join(nested, 'AGENTS.md'));
      expect(await fs.operations.findGitWorkTree('/')).toBeNull();
    } finally { calls.mockRestore(); }
  });

  it('pipelines a bounded window of write chunks in order', async () => {
    const path = join(workDir, 'pipelined.bin');
    const original = connection.call.bind(connection);
    let active = 0;
    let peak = 0;
    const calls = vi.spyOn(connection, 'call').mockImplementation(async (method, params) => {
      if (method !== 'fs/writeFile') return original(method, params);
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => { setTimeout(resolve, 10); });
        return await original(method, params);
      } finally { active -= 1; }
    });
    try {
      const bytes = Buffer.concat(Array.from({ length: 9 }, (_, index) => Buffer.alloc(1024 * 1024, index)));
      await fs.writeBytes(path, bytes);
      expect(peak).toBe(4);
      expect((await readFile(path)).equals(bytes)).toBe(true);
    } finally { calls.mockRestore(); }
  });

  it('does not append later chunks after an earlier exclusive write fails', async () => {
    const path = join(workDir, 'failed-pipeline.txt');
    await writeFile(path, 'original');
    const results = await Promise.allSettled([0, 1, 2].map((chunkIndex) => connection.call('fs/writeFile', {
      path, transferId: 'failed-write', chunkIndex, final: chunkIndex === 2,
      mode: chunkIndex === 0 ? 'exclusive' : 'append', dataBase64: Buffer.from('changed').toString('base64'),
    })));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('original');
  });

  it('rejects duplicate and out-of-order chunks without repeating an append', async () => {
    const path = join(workDir, 'ordered-write.txt');
    const first = { path, transferId: 'ordered-write', chunkIndex: 0, mode: 'append', dataBase64: Buffer.from('one').toString('base64') };
    await connection.call('fs/writeFile', first);
    await expect(connection.call('fs/writeFile', first)).rejects.toThrow('once and in order');
    await expect(connection.call('fs/writeFile', { ...first, chunkIndex: 2 })).rejects.toThrow('once and in order');
    await connection.call('fs/writeFile', { ...first, chunkIndex: 1, final: true, dataBase64: Buffer.from('two').toString('base64') });
    expect(await readFile(path, 'utf8')).toBe('onetwo');
  });

  it('cancels a remote text scan', async () => {
    const path = join(workDir, 'cancel-read.txt');
    await writeFile(path, 'line\n'.repeat(1_000_000));
    const controller = new AbortController();
    const pending = fs.operations.readTextPage(path, pageOptions(path), controller.signal);
    const timer = setTimeout(() => { controller.abort(); }, 20);
    try {
      expect(await pending).toEqual({ isError: true, output: 'Read aborted' });
    } finally { clearTimeout(timer); }
  });

  it('matches a batch of files without transferring nonmatching contents', async () => {
    const paths = [];
    for (let index = 0; index < 12; index += 1) {
      const absolute = join(workDir, `match-${index}.txt`);
      await writeFile(absolute, 'no match here\n'.repeat(10_000) + 'needle\n');
      paths.push({ path: `match-${index}.txt`, absolute });
    }
    const calls = vi.spyOn(connection, 'call');
    try {
      const result = await fs.operations.matchFiles(paths, { pattern: 'needle', regex: false, case_sensitive: true, context_lines: 0, max_files: 100, max_matches_per_file: 10, max_total_matches: 100 }, 30_000);
      expect(result.files_scanned).toBe(12);
      expect(result.files).toHaveLength(12);
      expect(result.files[0]?.matches).toEqual([{ line: 10001, col: 1, text: 'needle', before: [], after: [] }]);
      expect(calls.mock.calls.map(([method]) => method)).toEqual(['fs/matchFiles']);
      expect(Buffer.byteLength(JSON.stringify(await calls.mock.results[0]!.value))).toBeLessThan(4096);
    } finally { calls.mockRestore(); }
  });

  it('requests legacy matching when a remote result would exceed the response budget', async () => {
    const path = join(workDir, 'long-match.txt');
    await writeFile(path, 'needle' + 'x'.repeat(8 * 1024 * 1024));
    const result = await fs.operations.matchFiles([{ path: 'long-match.txt', absolute: path }], { pattern: 'needle', regex: false, case_sensitive: true, context_lines: 0, max_files: 1, max_matches_per_file: 1, max_total_matches: 1 }, 30_000);
    expect(result).toEqual({ files: [], files_scanned: 0, truncated: false, responseTooLarge: true });
  });

  it('reuses written and edited bytes only after the executor verifies their hash', async () => {
    const path = join(workDir, 'reuse.txt');
    await fs.operations.writeText({ path, parent: workDir, displayPath: 'reuse.txt', content: 'old value', mode: 'overwrite' });
    const calls = vi.spyOn(connection, 'call');
    try {
      const written = (await fs.operations.snapshotFiles([{ path }], 1024))[0]!;
      expect(written.kind).toBe('file');
      if (written.kind === 'file') expect(Buffer.from(written.bytes!).toString()).toBe('old value');
      expect(JSON.stringify(await calls.mock.results[0]!.value)).not.toContain('dataBase64');
      calls.mockClear();
      await fs.operations.editText({ path, displayPath: 'reuse.txt', old_string: 'old', new_string: 'new', replace_all: false });
      const edited = (await fs.operations.snapshotFiles([{ path }], 1024))[0]!;
      if (edited.kind === 'file') expect(Buffer.from(edited.bytes!).toString()).toBe('new value');
      expect(JSON.stringify(await calls.mock.results[1]!.value)).not.toContain('dataBase64');
      await writeFile(path, 'external!');
      const changed = (await fs.operations.snapshotFiles([{ path }], 1024))[0]!;
      if (changed.kind === 'file') expect(Buffer.from(changed.bytes!).toString()).toBe('external!');
    } finally { calls.mockRestore(); }
  });

  it('writes a byte stream progressively without retaining the complete input', async () => {
    const path = join(workDir, 'stream.bin');
    await fs.writeText(path, 'old content');
    const chunkSize = 2 * 1024 * 1024 + 3;
    async function* input(): AsyncGenerator<Uint8Array> {
      for (let index = 1; index <= 3; index += 1) {
        yield new Uint8Array(chunkSize).fill(index);
        expect((await fs.stat(path)).size).toBeGreaterThanOrEqual((index - 1) * chunkSize);
      }
    }
    await fs.writeBytes(path, input());

    const data = await fs.readBytes(path);
    expect(data.byteLength).toBe(3 * chunkSize);
    expect(Buffer.from(data).equals(Buffer.concat([
      Buffer.alloc(chunkSize, 1),
      Buffer.alloc(chunkSize, 2),
      Buffer.alloc(chunkSize, 3),
    ]))).toBe(true);
  });

  it('round-trips binary data written across chunk boundaries', async () => {
    const path = join(workDir, 'binary.bin');
    const data = new Uint8Array(2 * 1024 * 1024 + 7);
    for (let i = 0; i < data.byteLength; i += 1) data[i] = (i * 131 + 7) % 256;
    await fs.writeBytes(path, data);
    await fs.appendText(path, '中'.repeat(400 * 1024));

    const read = await fs.readBytes(path);
    expect(Buffer.from(read).equals(Buffer.concat([Buffer.from(data), Buffer.from('中'.repeat(400 * 1024))]))).toBe(true);
  }, 30_000);

  it('reads files larger than the whole-file limit in bounded chunks', async () => {
    const path = join(workDir, 'big.bin');
    const size = FS_READ_FILE_WHOLE_MAX_BYTES + 1024 * 1024;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) data[i] = i % 251;
    await writeFile(path, data);

    const read = await fs.readBytes(path);
    expect(read.byteLength).toBe(size);
    expect(Buffer.from(read).equals(Buffer.from(data))).toBe(true);
  }, 30_000);

  it('creates exclusively and reports false for an existing path', async () => {
    const path = join(workDir, 'exclusive.txt');
    await expect(fs.createExclusive(path, new Uint8Array([1, 2, 3]))).resolves.toBe(true);
    await expect(fs.createExclusive(path, new Uint8Array([4]))).resolves.toBe(false);
    await expect(fs.readBytes(path)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reads lines including a multi-chunk file', async () => {
    const path = join(workDir, 'lines.txt');
    const lines: string[] = [];
    for (let i = 0; i < 30_000; i += 1) {
      lines.push(`line-${i}-${'x'.repeat(i % 50)}`);
    }
    const content = `${lines.join('\n')}\n`;
    await fs.writeText(path, content);
    expect(content.length).toBeGreaterThan(1024 * 1024);
    const collected: string[] = [];
    for await (const line of fs.readLines(path)) {
      collected.push(line);
    }
    expect(collected).toEqual(lines.map((line) => `${line}\n`));
  });

  it('maps io failures to fs domain errors', async () => {
    await expect(fs.readText(join(workDir, 'missing.txt'))).rejects.toMatchObject({
      name: 'HostFsError',
      code: 'os.fs.not_found',
    });
    const file = join(workDir, 'not-a-dir.txt');
    await fs.writeText(file, 'x');
    await expect(fs.readdir(file)).rejects.toMatchObject({ code: 'os.fs.not_directory' });
    await expect(fs.readText(workDir)).rejects.toMatchObject({ code: 'os.fs.is_directory' });
  });

  it.each([false, true])('writes an empty stream when the destination exists: %s', async (exists) => {
    const path = join(workDir, `empty-${exists}.bin`);
    if (exists) await fs.writeText(path, 'old content');
    async function* input(): AsyncGenerator<Uint8Array> {
      yield* [];
    }
    await fs.writeBytes(path, input());

    expect((await fs.stat(path)).size).toBe(0);
    await expect(fs.readBytes(path)).resolves.toEqual(new Uint8Array(0));
  });
});

describe('fs protocol semantics', () => {
  const walkOptions = {
    maxDepth: 64,
    maxDirectories: 10_000,
    maxEntries: 100_000,
    maxResponseBytes: 8 * 1024 * 1024,
  };

  it('honors the caller deadline before and during a remote walk', async () => {
    const calls: Array<{ method: string; timeoutMs?: number }> = [];
    const fs = new RemoteFileSystem({
      call: async (method, params) => {
        calls.push({ method, timeoutMs: (params as { timeoutMs: number }).timeoutMs });
        return { entries: [], errors: [], truncated: false, responseBytes: 64 };
      },
      notify: () => {},
      onNotification: () => () => {},
      onDidClose: () => {},
    });

    const active = await fs.walk('/root', { ...walkOptions, deadlineMs: Date.now() + 1_000 });
    const expired = await fs.walk('/root', { ...walkOptions, deadlineMs: Date.now() });

    expect(active.truncated).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(FS_WALK_METHOD);
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(1_000);
    expect(expired).toEqual({ entries: [], errors: [], truncated: true, responseBytes: 0 });
  });

  it('walks nested directories in one rpc and prunes ignored subtrees', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remote-exec-walk-'));
    const { connection, loopback } = await connectInProcess();
    const methods: string[] = [];
    loopback.clientInput.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').trim().split('\n')) {
        if (line.length > 0) methods.push((JSON.parse(line) as { method?: string }).method ?? '');
      }
    });
    try {
      await mkdir(join(dir, 'src/nested'), { recursive: true });
      await mkdir(join(dir, 'node_modules/pkg'), { recursive: true });
      await writeFile(join(dir, 'src/nested/app.ts'), '');
      await writeFile(join(dir, 'node_modules/pkg/index.ts'), '');
      const fs = new RemoteFileSystem(connection);
      const result = await fs.walk(dir, {
        ...walkOptions,
        ignore: ['node_modules/'],
      });

      expect(result.entries.map((entry) => entry.name.slice(dir.length + 1)).toSorted()).toEqual([
        'src',
        'src/nested',
        'src/nested/app.ts',
      ]);
      expect(result.errors).toEqual([]);
      expect(result.truncated).toBe(false);
      expect(methods.filter((method) => method === FS_WALK_METHOD)).toHaveLength(1);
      expect(methods.filter((method) => method === FS_READ_DIRECTORY_METHOD)).toHaveLength(0);
    } finally {
      connection.close();
      await loopback.host.done;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back locally for oversized ignore rules without pruning them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remote-exec-walk-ignore-cap-'));
    const { connection, loopback } = await connectInProcess();
    const methods: string[] = [];
    loopback.clientInput.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').trim().split('\n')) {
        if (line.length > 0) methods.push((JSON.parse(line) as { method?: string }).method ?? '');
      }
    });
    try {
      await mkdir(join(dir, 'src'));
      await mkdir(join(dir, 'ignored'));
      await writeFile(join(dir, 'src/app.ts'), '');
      await writeFile(join(dir, 'ignored/app.ts'), '');
      const fs = new RemoteFileSystem(connection);
      const unusedRule = `unused-${'x'.repeat(8 * 1024)}`;
      const unusedRuleCount = Math.ceil(HOST_WALK_MAX_IGNORE_BYTES / Buffer.byteLength(JSON.stringify(unusedRule)));

      const result = await fs.walk(dir, {
        ...walkOptions,
        ignore: ['ignored/', ...Array.from({ length: unusedRuleCount }, () => unusedRule)],
      });

      expect(result.entries.map((entry) => entry.name.slice(dir.length + 1)).toSorted()).toEqual([
        'src',
        'src/app.ts',
      ]);
      expect(result.truncated).toBe(false);
      expect(methods.filter((method) => method === FS_WALK_METHOD)).toHaveLength(0);
      expect(methods.filter((method) => method === FS_READ_DIRECTORY_METHOD)).toHaveLength(2);
    } finally {
      connection.close();
      await loopback.host.done;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects oversized ignore rules on the wire', async () => {
    const loopback = createInProcessLoopback();
    const raw = new RawClient(loopback);
    await raw.handshake();
    raw.send({
      id: 1,
      method: FS_WALK_METHOD,
      params: {
        path: '/root',
        ignore: ['x'.repeat(HOST_WALK_MAX_IGNORE_BYTES)],
      },
    });

    const response = await raw.nextResponse(1);
    expect(response['error']).toMatchObject({ code: RpcErrorCode.InvalidParams });
    loopback.clientInput.end();
    await loopback.host.done;
  });

  it('reports capped directory listings on the wire and rejects them through the filesystem interface', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remote-exec-readdir-cap-'));
    const smallDir = await mkdtemp(join(tmpdir(), 'remote-exec-readdir-small-'));
    try {
      const total = FS_READ_DIRECTORY_MAX_ENTRIES + 1;
      for (let start = 0; start < total; start += 1000) {
        await Promise.all(
          Array.from({ length: Math.min(1000, total - start) }, (_, index) =>
            writeFile(join(dir, `entry-${String(start + index).padStart(6, '0')}`), ''),
          ),
        );
      }
      await writeFile(join(smallDir, 'a'), '');
      const loopback = createInProcessLoopback();
      const raw = new RawClient(loopback);
      await raw.handshake();
      raw.send({ id: 1, method: 'fs/readDirectory', params: { path: dir } });
      const capped = (await raw.nextResponse(1, 30_000))['result'] as {
        entries: unknown[];
        truncated: boolean;
      };
      expect(capped.entries.length).toBe(FS_READ_DIRECTORY_MAX_ENTRIES);
      expect(capped.truncated).toBe(true);

      raw.send({ id: 2, method: 'fs/readDirectory', params: { path: smallDir } });
      const complete = (await raw.nextResponse(2, 30_000))['result'] as {
        entries: unknown[];
        truncated: boolean;
      };
      expect(complete.entries.length).toBe(1);
      expect(complete.truncated).toBe(false);
      loopback.clientInput.end();
      await loopback.host.done;

      const adapterLoopback = createInProcessLoopback();
      const connection = await RemoteExecConnection.connect(adapterLoopback.clientPipe, {
        clientName: 'remote-exec-test',
        clientVersion: '0.0.0',
      });
      try {
        const fs = new RemoteFileSystem(connection);
        const listing = fs.readdir(dir);
        await expect(listing).rejects.toBeInstanceOf(HostFsError);
        await expect(listing).rejects.toMatchObject({
          code: 'os.fs.directory_too_large',
          details: { path: dir, op: 'readdir', limit: FS_READ_DIRECTORY_MAX_ENTRIES },
        });
        await expect(listing).rejects.toThrow(dir);
        await expect(listing).rejects.toThrow(String(FS_READ_DIRECTORY_MAX_ENTRIES));
        await expect(fs.readdir(smallDir)).resolves.toEqual([
          { name: 'a', isFile: true, isDirectory: false, isSymbolicLink: false },
        ]);
      } finally {
        connection.close();
        await adapterLoopback.host.done;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(smallDir, { recursive: true, force: true });
    }
  }, 60_000);
});

function pageOptions(path: string, args: Partial<TextPageOptions['args']> = {}): TextPageOptions {
  return { args: { path, ...args }, maxChars: 2000, maxCharsLimit: 500_000, eventLog: false, imageSupported: false, videoSupported: false, mediaToolAvailable: false };
}
