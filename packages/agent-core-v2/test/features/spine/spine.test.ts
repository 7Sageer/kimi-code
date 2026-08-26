import { afterEach, describe, expect, it } from 'vitest';

import { IFlagService } from '#/app/flag/flag';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { SPINE_FLAG_ID } from '#/features/spine/flag';
import { IAgentSpineService, SPINE_TOOL_NAMES } from '#/features/spine/spine';
import { ACCEPTED_OUTPUT, toControlResult } from '#/features/spine/tools/controlResult';

import { stubFlag } from '../../app/flag/stubs';
import {
  appService,
  testAgent,
  type TestAgentContext,
  type TestAgentServiceOverride,
} from '../../harness';

function spineAgent(...inputs: readonly TestAgentServiceOverride[]): TestAgentContext {
  const ctx = testAgent(...inputs);
  void ctx.restoreRuntimes();
  return ctx;
}

function withSpineFlag() {
  return appService(IFlagService, stubFlag((id) => id === SPINE_FLAG_ID));
}

describe('spine feature assembly', () => {
  let ctx: TestAgentContext | undefined;
  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  it('registers the four spine tools for the main agent when the flag is on', () => {
    ctx = spineAgent(withSpineFlag());
    const names = spineToolNames(ctx);
    expect(names).toEqual(expect.arrayContaining([...SPINE_TOOL_NAMES]));
    expect(names).toHaveLength(4);
  });

  it('does not register spine tools when the flag is off', () => {
    ctx = spineAgent();
    expect(spineToolNames(ctx)).toHaveLength(0);
  });

  it('does not register spine tools for a non-main agent', async () => {
    ctx = spineAgent(withSpineFlag());
    const lifecycle = ctx.get(IAgentLifecycleService);
    const sub = await lifecycle.create({ agentId: 'sub-1' });
    const handle = lifecycle.handleOf(sub.agentId);
    expect(handle).toBeDefined();
    await handle!.accessor.get(IAgentToolActivationService).activate();

    const subRegistry = handle!.accessor.get(IAgentToolRegistryService);
    for (const name of SPINE_TOOL_NAMES) {
      expect(subRegistry.resolve(name)).toBeUndefined();
    }
    expect(spineToolNames(ctx)).toHaveLength(4);
  });

  it('keeps spine tool names out of the Agent tool description', () => {
    ctx = spineAgent(withSpineFlag());
    const description = ctx.get(IAgentToolRegistryService).resolve('Agent')?.description ?? '';
    expect(description).toContain('Available agent types');
    for (const name of SPINE_TOOL_NAMES) {
      expect(description).not.toContain(name);
    }
  });

  it('whitelists the spine tools in the default agent profile', () => {
    ctx = spineAgent(withSpineFlag());
    ctx.configure({ tools: ['Read', ...SPINE_TOOL_NAMES] });
    const spine = ctx.toolsData().filter((tool) => tool.name.startsWith('spine_'));
    expect(spine).toHaveLength(4);
    expect(spine.every((tool) => tool.active)).toBe(true);
  });
});

describe('spine projection integration', () => {
  let ctx: TestAgentContext | undefined;
  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  it('folds a closed span in the projection while stored history stays intact', () => {
    ctx = spineAgent(withSpineFlag());
    buildClosedNodeHistory(ctx);

    const stored = ctx.context.get();
    const projected = ctx.project();

    expect(stored).toHaveLength(7);
    expect(stored.some((m) => textOf(m).includes('working'))).toBe(true);
    expect(stored.every((m) => !textOf(m).includes('<spine_memory'))).toBe(true);

    const texts = projected.map(textOf);
    expect(texts.some((text) => text.includes('<spine_memory node_id="1.1.1"'))).toBe(true);
    expect(texts.some((text) => text.includes('did A'))).toBe(true);
    expect(texts.some((text) => text.includes('working'))).toBe(false);
    expect(texts.some((text) => text.includes('<spine_status'))).toBe(true);
    expect(texts.some((text) => text.includes('[U1] start'))).toBe(true);
  });

  it('leaves the projection untouched when the flag is off', () => {
    ctx = spineAgent();
    buildClosedNodeHistory(ctx);

    const projected = ctx.project();
    const texts = projected.map(textOf);
    expect(texts.some((text) => text.includes('working'))).toBe(true);
    expect(texts.some((text) => text.includes('<spine_memory'))).toBe(false);
    expect(texts.some((text) => text.includes('<spine_status'))).toBe(false);
    expect(texts.some((text) => text.includes('<spine_node'))).toBe(false);
  });

  it('does not fold operation requests that carry their own messages', async () => {
    ctx = spineAgent(withSpineFlag());
    buildClosedNodeHistory(ctx);
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'summary' });
    ctx.mockNextResponse({ type: 'text', text: 'turn reply' });

    const requester = ctx.get(IAgentLLMRequesterService);
    await requester.request({
      messages: ctx.context.get(),
      source: { type: 'operation', requestKind: 'full_compaction' },
    });
    await requester.request({ source: { type: 'turn', turnId: 1 } });

    const operationHistory = ctx.llmCalls[0]?.history ?? [];
    const operationTexts = operationHistory.map(textOf);
    expect(operationTexts.some((text) => text.includes('working'))).toBe(true);
    expect(operationTexts.some((text) => text.includes('<spine_memory'))).toBe(false);
    expect(operationTexts.some((text) => text.includes('<spine_status'))).toBe(false);

    const turnHistory = ctx.llmCalls[1]?.history ?? [];
    const turnTexts = turnHistory.map(textOf);
    expect(turnTexts.some((text) => text.includes('<spine_memory node_id="1.1.1"'))).toBe(true);
    expect(turnTexts.some((text) => text.includes('working'))).toBe(false);
  });

  it('injects the spine view reminder when the tools are active', async () => {
    ctx = spineAgent(withSpineFlag());
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    const view = ctx.context
      .get()
      .find(
        (m) => m.origin?.kind === 'injection' && m.origin.variant === 'spine_view',
      );
    expect(view).toBeDefined();
    expect(textOf(view)).toContain('<spine_view>');
    expect(textOf(view)).toContain('Spine-managed');
    const firstRequest = ctx.llmCalls[0]?.history ?? [];
    expect(firstRequest.map(textOf).some((text) => text.includes('<spine_view>'))).toBe(true);
  });

  it('injects no spine view reminder when the flag is off', async () => {
    ctx = spineAgent();
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    expect(
      ctx.context
        .get()
        .some((m) => m.origin?.kind === 'injection' && m.origin.variant === 'spine_view'),
    ).toBe(false);
  });

  it('re-injects the spine view after the span carrying it closes', async () => {
    ctx = spineAgent(withSpineFlag());
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_close', 'spine_close', { memory: 'startup done' }));
    ctx.mockNextResponse({ type: 'text', text: 'closed' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const views = ctx.context
      .get()
      .filter((m) => m.origin?.kind === 'injection' && m.origin.variant === 'spine_view');
    expect(views).toHaveLength(2);
  });
});

describe('spine transitions through the loop', () => {
  let ctx: TestAgentContext | undefined;
  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  it('commits open then close across steps and folds the next request', async () => {
    ctx = spineAgent(withSpineFlag());
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(toolCallPart('call_close', 'spine_close', { memory: 'did A' }));
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = ctx.get(IAgentSpineService).currentState();
    expect(state.nodes['1.1.1']?.summary).toBe('task A');
    expect(state.nodes['1.1.1']?.closedAt).toBeDefined();
    expect(state.nodes['1.1.1']?.memory).toBe('did A');
    expect(state.openStack).toEqual(['1', '1.1']);

    const receipt = ctx.context.get().find((m) => m.role === 'tool' && m.toolCallId === 'call_open');
    expect(receipt?.isError).not.toBe(true);
    expect(textOf(receipt)).toBe(ACCEPTED_OUTPUT);

    const secondRequest = ctx.llmCalls[1]?.history ?? [];
    expect(
      secondRequest.map(textOf).some((text) => text.includes('<spine_node id="1.1.1"')),
    ).toBe(true);
    const thirdRequest = ctx.llmCalls[2]?.history ?? [];
    const thirdTexts = thirdRequest.map(textOf);
    expect(thirdTexts.some((text) => text.includes('<spine_memory node_id="1.1.1"'))).toBe(true);
  });

  it('rejects a second spine transition in the same step', async () => {
    ctx = spineAgent(withSpineFlag());
    await configureLoop(ctx);
    ctx.mockNextResponse(
      toolCallPart('call_open_1', 'spine_open', { summary: 'task A' }),
      toolCallPart('call_open_2', 'spine_open', { summary: 'task B' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = ctx.get(IAgentSpineService).currentState();
    expect(state.nodes['1.1.1']?.summary).toBe('task A');
    expect(state.nodes['1.1.2']).toBeUndefined();

    const rejected = ctx.context
      .get()
      .find((m) => m.role === 'tool' && m.toolCallId === 'call_open_2');
    expect(rejected?.isError).toBe(true);
  });

  it('renders the current tree through the spine_tree tool', async () => {
    ctx = spineAgent(withSpineFlag());
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(toolCallPart('call_tree', 'spine_tree', {}));
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const treeMessage = ctx.context
      .get()
      .find((m) => m.role === 'tool' && m.toolCallId === 'call_tree');
    const output = textOf(treeMessage);
    expect(output).toContain('1.1.1');
    expect(output).toContain('task A');
    expect(output).toContain('cursor');
  });
});

describe('spine accept guards', () => {
  let ctx: TestAgentContext | undefined;
  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  it('rejects every transition when the flag is off', () => {
    ctx = spineAgent();
    const spine = ctx.get(IAgentSpineService);
    expect(spine.enabled).toBe(false);
    expect(spine.acceptOpen('task A').accepted).toBe(false);
    expect(spine.acceptClose('mem').accepted).toBe(false);
    expect(spine.acceptNext('task B', 'mem').accepted).toBe(false);
  });

  it('rejects empty summaries and memories', () => {
    ctx = spineAgent(withSpineFlag());
    const spine = ctx.get(IAgentSpineService);
    expect(spine.acceptOpen('   ')).toEqual({ accepted: false, reason: expect.any(String) });

    ctx = spineAgent(withSpineFlag());
    expect(ctx.get(IAgentSpineService).acceptClose('  ').accepted).toBe(false);

    ctx = spineAgent(withSpineFlag());
    expect(ctx.get(IAgentSpineService).acceptNext('', 'mem').accepted).toBe(false);

    ctx = spineAgent(withSpineFlag());
    expect(ctx.get(IAgentSpineService).acceptNext('task B', '  ').accepted).toBe(false);
  });

  it('allows one transition per step and rejects the next', () => {
    ctx = spineAgent(withSpineFlag());
    const spine = ctx.get(IAgentSpineService);
    expect(spine.acceptOpen('task A').accepted).toBe(true);
    const second = spine.acceptClose('mem');
    expect(second.accepted).toBe(false);
    if (!second.accepted) expect(second.reason).toContain('at most one');
  });

  it('rejects closing a root epoch', () => {
    ctx = spineAgent(withSpineFlag());
    append(ctx, assistantToolCall('c1', 'spine_close', JSON.stringify({ memory: 'startup done' })));
    append(ctx, spineAcceptedReceipt('c1'));
    const spine = ctx.get(IAgentSpineService);
    expect(spine.currentState().openStack).toEqual(['1']);

    const result = spine.acceptClose('mem');
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toContain('Root-epoch');
  });

  it('maps an accepted transition to the delayed-commit receipt', () => {
    const result = toControlResult({ accepted: true });
    expect(result.isError).toBe(false);
    if (result.isError === false) {
      expect(result.output).toBe(ACCEPTED_OUTPUT);
      expect(result.output).toMatch(/^accepted/);
      expect(result.output).toContain('commit');
    }
  });
});

async function configureLoop(ctx: TestAgentContext): Promise<void> {
  ctx.configure();
  await ctx.rpc.setPermission({ mode: 'yolo' });
}

function spineToolNames(ctx: TestAgentContext): string[] {
  return ctx
    .toolsData()
    .map((tool) => tool.name)
    .filter((name) => name.startsWith('spine_'));
}

function buildClosedNodeHistory(ctx: TestAgentContext): void {
  append(ctx, userMessage('start'));
  append(ctx, assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'task A' })));
  append(ctx, spineAcceptedReceipt('c_open'));
  append(ctx, assistantText('working'));
  append(ctx, assistantToolCall('c_close', 'spine_close', JSON.stringify({ memory: 'did A' })));
  append(ctx, spineAcceptedReceipt('c_close'));
  append(ctx, userMessage('after'));
}

function append(ctx: TestAgentContext, message: ContextMessage): number {
  const index = ctx.context.get().length;
  ctx.context.append(message);
  return index;
}

function userMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'user' },
  };
}

function assistantText(text: string): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
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

function textOf(
  message: { content?: readonly { type: string; text?: string }[] } | undefined,
): string {
  return (
    message?.content?.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('') ?? ''
  );
}
