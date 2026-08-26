import { afterEach, describe, expect, it, vi } from 'vitest';

import { IFlagService } from '#/app/flag/flag';
import {
  buildCompactionSummaryText,
  createCompactionSummaryMessage,
} from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { SPINE_FLAG_ID } from '#/features/spine/flag';
import { IAgentSpineService } from '#/features/spine/spine';
import { ACCEPTED_OUTPUT } from '#/features/spine/tools/controlResult';
import { WIRE_PROTOCOL_VERSION, type WireRecord } from '#/index';

import { stubFlag } from '../../app/flag/stubs';
import {
  appService,
  execEnvServices,
  InMemoryWireRecordPersistence,
  testAgent,
  wireRecordPersistenceServices,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../../harness';

type GenerateFn = NonNullable<TestAgentOptions['generate']>;

const CATALOGUED_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'kimi-code',
  baseUrl: 'http://127.0.0.1',
} as const;
const CATALOGUED_MODEL_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

function spineAgent(
  ...inputs: readonly (TestAgentServiceOverride | TestAgentOptions)[]
): TestAgentContext {
  const ctx = testAgent(appService(IFlagService, stubFlag((id) => id === SPINE_FLAG_ID)), ...inputs);
  void ctx.restoreRuntimes();
  return ctx;
}

describe('spine root compaction', () => {
  let ctx: TestAgentContext | undefined;
  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
    vi.useRealTimers();
  });

  it('routes full compaction into a spine root epoch instead of rebuilding history', async () => {
    ctx = spineAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user', 'old assistant', 20);
    ctx.appendExchange(2, 'recent user', 'recent assistant', 80);

    const completed = onceComplete(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;

    const recordTypes = (await ctx.persistedWireRecords()).map((record) => record.type);
    expect(recordTypes).not.toContain('context.apply_compaction');

    const state = ctx.get(IAgentSpineService).currentState();
    expect(state.rootEpoch).toBe(2);
    expect(state.openStack).toEqual(['2', '2.1']);
    expect(state.epochMemoryAt).toBeDefined();

    const lastMessage = ctx.context.get().at(-1);
    expect(lastMessage?.origin?.kind).toBe('compaction_summary');
    expect(textOf(lastMessage)).toContain('Summary.');

    const projected = ctx.project();
    expect(projected.some((m) => textOf(m).includes('old assistant'))).toBe(false);
    expect(textOf(projected[0])).toContain('Summary.');
  });

  it('keeps the stored history append-only across the epoch boundary', async () => {
    ctx = spineAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user', 'old assistant', 20);
    const before = ctx.context.get().length;

    const completed = onceComplete(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;

    const stored = ctx.context.get();
    expect(stored).toHaveLength(before + 1);
    expect(stored[0]).toBeDefined();
    expect(textOf(stored[1])).toContain('old assistant');
  });

  it('archives the folded-out context and publishes the path on the new epoch node', async () => {
    const writes = new Map<string, string>();
    ctx = spineAgent(execEnvServices({ hostFs: recordingHostFs(writes) }));
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user', 'old assistant', 20);
    ctx.appendExchange(2, 'recent user', 'recent assistant', 80);

    const completed = onceComplete(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;

    const archivePath = [...writes.keys()].find((path) =>
      path.endsWith('/agents/main/spine/2.md'),
    );
    expect(archivePath).toBeDefined();
    const content = writes.get(archivePath!) ?? '';
    expect(content).toContain('# Spine Root Epoch 2');
    expect(content).toContain('## Epoch Summary');
    expect(content).toContain('Summary.');
    expect(content).toContain('## Trajectory');
    expect(content).toContain('old user');
    expect(content).toContain('old assistant');
    expect(content).toContain('recent user');
    expect(content).toContain('recent assistant');

    expect(ctx.get(IAgentSpineService).renderTree()).toContain(archivePath!);
  });

  it('completes the root compaction without an archive path when the archive write fails', async () => {
    ctx = spineAgent(execEnvServices({ hostFs: failingHostFs() }));
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user', 'old assistant', 20);

    const completed = onceComplete(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;

    const recordTypes = (await ctx.persistedWireRecords()).map((record) => record.type);
    expect(recordTypes).toContain('full_compaction.complete');
    const state = ctx.get(IAgentSpineService).currentState();
    expect(state.rootEpoch).toBe(2);
    const tree = ctx.get(IAgentSpineService).renderTree();
    expect(tree).toContain('2 [open]');
    expect(tree).not.toContain('2.md');
  });

  it('keeps previous epochs and their archive paths reachable in the tree', () => {
    ctx = spineAgent();
    append(ctx, assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'task A' })));
    append(ctx, spineAcceptedReceipt('c_open'));
    append(ctx, assistantToolCall('c_close', 'spine_close', JSON.stringify({ memory: 'did A' })));
    append(ctx, spineAcceptedReceipt('c_close'));
    append(ctx, createCompactionSummaryMessage(buildCompactionSummaryText('epoch summary')));

    const tree = ctx.get(IAgentSpineService).renderTree();

    expect(tree).toContain('1 [closed]');
    expect(tree).toContain('1.1.1');
    expect(tree).toContain('task A');
    expect(tree).toContain('archive:');
    expect(tree).toContain('1-1-1.md');
    expect(tree).toContain('2 [open, archive:');
  });

  it('summarizes only the current epoch and chains the previous epoch summary', async () => {
    const summaryInputs: string[] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      const text = history.map((message) => textOf(message)).join('\n');
      if (text.includes('You are about to run out of context.')) summaryInputs.push(text);
      return {
        id: 'mock-epoch-summary',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'epoch summary' }],
          toolCalls: [],
        },
        usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    ctx = spineAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });

    ctx.appendExchange(1, 'EPOCH-ONE-MARKER old user', 'old assistant', 20);
    const first = onceComplete(ctx);
    await ctx.rpc.beginCompaction({});
    await first;

    ctx.appendExchange(2, 'EPOCH-TWO-MARKER new user', 'new assistant', 20);
    summaryInputs.length = 0;
    const second = onceComplete(ctx);
    await ctx.rpc.beginCompaction({});
    await second;

    expect(summaryInputs).toHaveLength(1);
    const input = summaryInputs[0]!;
    expect(input).toContain('EPOCH-TWO-MARKER');
    expect(input).toContain('epoch summary');
    expect(input).not.toContain('EPOCH-ONE-MARKER');
  });
});

describe('spine node archives', () => {
  let ctx: TestAgentContext | undefined;
  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  it('writes a trajectory archive on close and publishes its path', async () => {
    const writes = new Map<string, string>();
    ctx = spineAgent(execEnvServices({ hostFs: recordingHostFs(writes) }));
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('c_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(toolCallPart('c_close', 'spine_close', { memory: 'did A' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    expect(ctx.get(IAgentSpineService).currentState().nodes['1.1.1']?.closedAt).toBeDefined();
    const archivePath = [...writes.keys()].find((path) =>
      path.endsWith('/agents/main/spine/1-1-1.md'),
    );
    expect(archivePath).toBeDefined();
    const content = writes.get(archivePath!) ?? '';
    expect(content).toContain('did A');
    expect(content).toContain('task A');
    expect(content).toContain('## Trajectory');

    expect(ctx.get(IAgentSpineService).renderTree()).toContain(archivePath!);
  });

  it('closes the node and marks its memory when the archive write fails', async () => {
    ctx = spineAgent(execEnvServices({ hostFs: failingHostFs() }));
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('c_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(toolCallPart('c_close', 'spine_close', { memory: 'did A' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = ctx.get(IAgentSpineService).currentState();
    expect(state.nodes['1.1.1']?.closedAt).toBeDefined();
    const tree = ctx.get(IAgentSpineService).renderTree();
    expect(tree).toContain('1.1.1 [closed');
    expect(tree).not.toContain('1-1-1.md');
    const projected = ctx.project().map(textOf).join('\n');
    expect(projected).toContain('could not be written');
  });

  it('replays the tree and rewrites the archive after a restore', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const firstWrites = new Map<string, string>();
    ctx = spineAgent(
      execEnvServices({ hostFs: recordingHostFs(firstWrites) }),
      wireRecordPersistenceServices(persistence),
    );
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('c_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(toolCallPart('c_close', 'spine_close', { memory: 'did A' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();
    await ctx.wire.flush();

    const before = ctx.get(IAgentSpineService).currentState();
    const resumedWrites = new Map<string, string>();
    const resumed = spineAgent(
      execEnvServices({ hostFs: recordingHostFs(resumedWrites) }),
      wireRecordPersistenceServices(
        new InMemoryWireRecordPersistence(withMetadata(cloneRecords(persistence.records))),
      ),
    );
    try {
      await resumed.restorePersisted();

      const after = resumed.get(IAgentSpineService).currentState();
      expect(after.openStack).toEqual(before.openStack);
      expect(after.nodes['1.1.1']?.summary).toBe('task A');
      expect(after.nodes['1.1.1']?.closedAt).toBe(before.nodes['1.1.1']?.closedAt);
      expect(after.nodes['1.1.1']?.memory).toContain('did A');
      expect(resumed.get(IAgentSpineService).renderTree()).toContain('1-1-1.md');
    } finally {
      await resumed.dispose();
    }
  });
});

async function configureLoop(ctx: TestAgentContext): Promise<void> {
  ctx.configure({
    provider: CATALOGUED_PROVIDER,
    modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
  });
  await ctx.rpc.setPermission({ mode: 'yolo' });
}

function onceComplete(ctx: TestAgentContext): Promise<void> {
  return new Promise<void>((resolve) => {
    ctx.emitter.once('full_compaction.complete', () => {
      resolve();
    });
  });
}

function append(ctx: TestAgentContext, message: ContextMessage): number {
  const index = ctx.context.get().length;
  ctx.context.append(message);
  return index;
}

function assistantToolCall(id: string, name: string, args: string = '{}'): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: `calling ${name}` }],
    toolCalls: [{ type: 'function', id, name, arguments: args }],
  };
}

function spineAcceptedReceipt(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: ACCEPTED_OUTPUT }],
    toolCalls: [],
    toolCallId,
  };
}

function toolCallPart(
  id: string,
  name: string,
  args: Record<string, unknown>,
): {
  readonly type: 'function';
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
} {
  return { type: 'function', id, name, arguments: JSON.stringify(args) };
}

function recordingHostFs(writes: Map<string, string>) {
  return {
    writeText: async (path: string, data: string) => {
      writes.set(path, data);
    },
    mkdir: async () => {},
  };
}

function failingHostFs() {
  return {
    writeText: async () => {
      throw new Error('disk full');
    },
    mkdir: async () => {},
  };
}

function cloneRecords<T>(records: readonly T[]): T[] {
  return records.map((record) => structuredClone(record));
}

function withMetadata(records: readonly WireRecord[]): WireRecord[] {
  if (records[0]?.type === 'metadata') return [...records];
  return [
    { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
    ...records,
  ];
}

function textOf(
  message: { content?: readonly { type: string; text?: string }[] } | undefined,
): string {
  return (
    message?.content?.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('') ?? ''
  );
}
