import type { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { TEXT_PAGE_MAX_REMOTE_CHARS, type TextFileResult, type TextEditResult } from '#/os/interface/fileOperations';
import { findGitWorkTree } from '#/os/operations/gitWorkTree';
import { discoverInstructions } from '#/os/operations/instructions';
import { matchFiles } from '#/os/operations/matchFiles';
import { snapshotFiles } from '#/os/operations/snapshotFiles';
import { FS_MAX_ACTIVE_READS, FS_SNAPSHOT_MAX_FILES, FS_SNAPSHOT_MAX_FILE_BYTES } from '#/remote/protocol/methods';
import { encodeBase64 } from '#/remote/protocol/codec';
import { readTextPage } from '#/os/operations/readTextPage';
import { editText } from '#/os/operations/editText';
import { RpcError, RpcErrorCode } from '#/remote/protocol/errors';
import { optionalBoolean, optionalInteger, requireAbsolutePath, requireParams, requireString } from './fsHandler';

export class FileOperationsHandler {
  private readonly reads = new Map<string, { controller: AbortController; done: Promise<TextFileResult> }>();

  cancelRead(rawParams: unknown): void {
    const params = requireParams(rawParams);
    this.reads.get(requireString(params, 'readId'))?.controller.abort(new Error('Read aborted'));
  }

  async dispose(): Promise<void> {
    const pending = [...this.reads.values()];
    for (const read of pending) read.controller.abort(new Error('Read aborted'));
    await Promise.allSettled(pending.map((read) => read.done));
  }

  constructor(private readonly fs: HostFileSystem) {}

  async findGitWorkTree(rawParams: unknown): Promise<{ workTree: Awaited<ReturnType<typeof findGitWorkTree>> }> {
    const params = requireParams(rawParams);
    return { workTree: await findGitWorkTree(this.fs, requireAbsolutePath(params, 'cwd')) };
  }

  discoverInstructions(rawParams: unknown): Promise<string[]> {
    const params = requireParams(rawParams);
    const dirs = params['dirs'];
    const known = params['known'];
    if (!Array.isArray(dirs) || dirs.length > 64 || !Array.isArray(known) || known.some((path) => typeof path !== 'string')) throw new RpcError(RpcErrorCode.InvalidParams, 'invalid instruction directories');
    const paths = dirs.map((dir: unknown) => requireAbsolutePath({ dir }, 'dir'));
    return discoverInstructions(this.fs, paths, known);
  }

  matchFiles(rawParams: unknown): ReturnType<typeof matchFiles> {
    const params = requireParams(rawParams);
    const files = params['files'];
    if (!Array.isArray(files) || files.length > 128) throw new RpcError(RpcErrorCode.InvalidParams, 'too many match files');
    const paths = files.map((file: unknown) => {
      const value = requireParams(file);
      return { path: requireString(value, 'path'), absolute: requireAbsolutePath(value, 'absolute') };
    });
    const options = requireParams(params['options']);
    return matchFiles(this.fs, paths, {
      pattern: requireString(options, 'pattern'),
      regex: optionalBoolean(options, 'regex') ?? false,
      case_sensitive: optionalBoolean(options, 'case_sensitive') ?? true,
      context_lines: optionalInteger(options, 'context_lines', 0, 10) ?? 2,
      max_files: optionalInteger(options, 'max_files', 1, 10_000) ?? 200,
      max_matches_per_file: optionalInteger(options, 'max_matches_per_file', 1, 10_000) ?? 50,
      max_total_matches: optionalInteger(options, 'max_total_matches', 1, 100_000) ?? 5000,
    }, optionalInteger(params, 'timeoutMs', 1, 30_000) ?? 30_000, undefined, 8 * 1024 * 1024);
  }

  async snapshotFiles(rawParams: unknown): Promise<unknown> {
    const params = requireParams(rawParams);
    const files = params['files'];
    if (!Array.isArray(files) || files.length > FS_SNAPSHOT_MAX_FILES) throw new RpcError(RpcErrorCode.InvalidParams, 'too many snapshot files');
    const requests = files.map((file: unknown) => {
      const entry = requireParams(file);
      const knownHash = entry['knownHash'];
      if (knownHash !== undefined && (typeof knownHash !== 'string' || !/^[a-f0-9]{64}$/.test(knownHash))) throw new RpcError(RpcErrorCode.InvalidParams, 'invalid snapshot hash');
      return { path: requireAbsolutePath(entry, 'path'), knownHash };
    });
    const maxFileBytes = optionalInteger(params, 'maxFileBytes', 0, FS_SNAPSHOT_MAX_FILE_BYTES) ?? FS_SNAPSHOT_MAX_FILE_BYTES;
    const results = await snapshotFiles(this.fs, requests, maxFileBytes);
    return results.map((result) => result.kind === 'file' ? {
      kind: result.kind,
      contentHash: result.contentHash,
      dataBase64: result.bytes === undefined ? undefined : encodeBase64(result.bytes),
    } : result);
  }

  async readTextPage(rawParams: unknown): Promise<TextFileResult> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    const args = requireParams(params['args']);
    const lineOffset = optionalInteger(args, 'line_offset', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (lineOffset === 0) throw new RpcError(RpcErrorCode.InvalidParams, 'line_offset must be nonzero');
    const maxChars = optionalInteger(params, 'maxChars', 1, TEXT_PAGE_MAX_REMOTE_CHARS);
    const maxCharsLimit = optionalInteger(params, 'maxCharsLimit', 1, Number.MAX_SAFE_INTEGER);
    if (maxChars === undefined || maxCharsLimit === undefined) throw new RpcError(RpcErrorCode.InvalidParams, 'read limits are required');
    const readId = requireString(params, 'readId');
    if (this.reads.has(readId) || this.reads.size >= FS_MAX_ACTIVE_READS) throw new RpcError(RpcErrorCode.InvalidRequest, 'read ID is active or too many active reads');
    const controller = new AbortController();
    const done = readTextPage({
      name: path,
      stat: () => this.fs.stat(path),
      readBytes: (n) => this.fs.readBytes(path, n),
      readLines: () => this.fs.readLines(path, { errors: 'strict' }),
    }, {
      args: {
        path: requireString(args, 'path'),
        line_offset: lineOffset,
        column_offset: optionalInteger(args, 'column_offset', 0, Number.MAX_SAFE_INTEGER),
        n_lines: optionalInteger(args, 'n_lines', 1, Number.MAX_SAFE_INTEGER),
        max_chars: optionalInteger(args, 'max_chars', 1, Number.MAX_SAFE_INTEGER),
      },
      maxChars,
      maxCharsLimit,
      eventLog: optionalBoolean(params, 'eventLog') ?? false,
      imageSupported: optionalBoolean(params, 'imageSupported') ?? false,
      videoSupported: optionalBoolean(params, 'videoSupported') ?? false,
      mediaToolAvailable: optionalBoolean(params, 'mediaToolAvailable') ?? false,
    }, controller.signal);
    this.reads.set(readId, { controller, done });
    try {
      return await done;
    } finally {
      this.reads.delete(readId);
    }
  }

  editText(rawParams: unknown): Promise<TextEditResult> {
    const params = requireParams(rawParams);
    const newString = params['new_string'];
    if (typeof newString !== 'string') throw new RpcError(RpcErrorCode.InvalidParams, 'new_string must be a string');
    return editText(this.fs, {
      path: requireAbsolutePath(params, 'path'),
      displayPath: requireString(params, 'displayPath'),
      old_string: requireString(params, 'old_string'),
      new_string: newString,
      replace_all: optionalBoolean(params, 'replace_all') ?? false,
    });
  }
}
