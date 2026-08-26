import { describe, expect, it } from 'vitest';

import {
  buildCompactionSummaryText,
  createCompactionSummaryMessage,
} from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import { deriveSpineState } from '#/features/spine/spineDerive';
import { foldSpine, type SpineFoldStatus } from '#/features/spine/spineFold';
import type { SpineState } from '#/features/spine/spineState';
import {
  parentNodeId,
  renderTree,
  spineTreeViewFromState,
  epochRootIds,
  spineNodeViewFromState,
  type SpineTreeNodeView,
  type SpineTreeView,
} from '#/features/spine/spineTree';
import { ACCEPTED_OUTPUT } from '#/features/spine/tools/controlResult';

function foldMessages(
  messages: readonly ContextMessage[],
  maxContextTokens?: number,
): readonly ContextMessage[] {
  const state = deriveSpineState(messages);
  const epochSummaryMessage =
    state.epochMemoryAt === undefined ? undefined : messages[state.epochMemoryAt];
  return foldSpine(messages, { state, status: statusOf(state), epochSummaryMessage, maxContextTokens });
}

function statusOf(
  state: SpineState,
): Pick<SpineFoldStatus, 'cursorId' | 'summary' | 'parentId' | 'parentSummary'> {
  const cursorId = state.openStack.at(-1);
  if (cursorId === undefined) throw new Error('empty openStack');
  const parentId = parentNodeId(cursorId);
  return {
    cursorId,
    summary: state.nodes[cursorId]?.summary ?? '',
    parentId,
    parentSummary: parentId === null ? null : (state.nodes[parentId]?.summary ?? null),
  };
}

describe('spine derivation from the message stream', () => {
  it('derives the initial state from an empty history', () => {
    const state = deriveSpineState([]);
    expect(state.rootEpoch).toBe(1);
    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.epochStartAt).toBe(0);
    expect(state.epochMemoryAt).toBeUndefined();
  });

  it('ignores a transition whose receipt is a near-miss of the accepted carrier', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: 'task' })),
      toolReceipt('c1', `${ACCEPTED_OUTPUT}.`),
    ]);
    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('ignores a transition whose receipt is an error', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: 'task' })),
      { ...toolReceipt('c1', ACCEPTED_OUTPUT), isError: true },
    ]);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('applies only the spine call from a carrier batched with other tool calls', () => {
    const state = deriveSpineState([
      userMessage('start'),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'batching a spine call with a tool call' }],
        toolCalls: [
          {
            type: 'function',
            id: 'c_spine',
            name: 'spine_open',
            arguments: JSON.stringify({ summary: 'task' }),
          },
          { type: 'function', id: 'c_read', name: 'Read', arguments: '{}' },
        ],
      },
      toolReceipt('c_read', 'file contents'),
      toolReceipt('c_spine', ACCEPTED_OUTPUT),
    ]);
    expect(state.openStack).toEqual(['1', '1.1', '1.1.1']);
    expect(state.nodes['1.1.1']?.summary).toBe('task');
  });

  it('ignores a transition with malformed call arguments', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', '{not json'),
      toolReceipt('c1', ACCEPTED_OUTPUT),
    ]);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('ignores a transition with an empty summary', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: '   ' })),
      toolReceipt('c1', ACCEPTED_OUTPUT),
    ]);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('derives undo truncation from the surviving messages alone', () => {
    const messages = [
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: 'task' })),
      toolReceipt('c1', ACCEPTED_OUTPUT),
      assistantText('working'),
      assistantToolCall('c2', 'spine_close', JSON.stringify({ memory: 'done' })),
      toolReceipt('c2', ACCEPTED_OUTPUT),
    ];
    const full = deriveSpineState(messages);
    expect(full.nodes['1.1.1']?.closedAt).toBe(3);
    expect(full.openStack).toEqual(['1', '1.1']);

    const beforeClose = deriveSpineState(messages.slice(0, 4));
    expect(beforeClose.nodes['1.1.1']?.closedAt).toBeUndefined();
    expect(beforeClose.openStack).toEqual(['1', '1.1', '1.1.1']);

    const beforeOpen = deriveSpineState(messages.slice(0, 1));
    expect(beforeOpen.nodes['1.1.1']).toBeUndefined();
    expect(beforeOpen.openStack).toEqual(['1', '1.1']);
  });

  it('derives multiple root epochs from summary messages', () => {
    const state = deriveSpineState([
      userMessage('old'),
      createCompactionSummaryMessage(buildCompactionSummaryText('epoch 1 done')),
      userMessage('mid'),
      createCompactionSummaryMessage(buildCompactionSummaryText('epoch 2 done')),
      userMessage('now'),
    ]);
    expect(state.rootEpoch).toBe(3);
    expect(state.openStack).toEqual(['3', '3.1']);
    expect(state.epochStartAt).toBe(4);
    expect(state.epochMemoryAt).toBe(3);
    expect(state.nodes['1']).toBeDefined();
    expect(state.nodes['2']).toBeDefined();
  });

  it('detects an epoch boundary from the summary prefix when the origin is absent', () => {
    const state = deriveSpineState([
      userMessage('old'),
      compactionSummaryTextMessage(buildCompactionSummaryText('done')),
      userMessage('now'),
    ]);
    expect(state.rootEpoch).toBe(2);
    expect(state.epochMemoryAt).toBe(1);
  });

  it('trusts a non-summary origin over the summary prefix text', () => {
    const state = deriveSpineState([
      userMessage('old'),
      {
        ...compactionSummaryTextMessage(buildCompactionSummaryText('done')),
        origin: { kind: 'user' },
      },
      userMessage('now'),
    ]);
    expect(state.rootEpoch).toBe(1);
  });
});

describe('spine projection fold', () => {
  it('folds a closed node span into a memory slot without mutating the input', () => {
    const messages = buildClosedNodeHistory();
    const stored = [...messages];

    const folded = foldMessages(messages);

    expect(messages).toHaveLength(stored.length);
    expect(messages.every((message, index) => message === stored[index])).toBe(true);
    expect(folded).toHaveLength(7);
    expect(textOf(folded[0])).toBe(
      '<spine_node id="1.1" summary="startup" status="live" />',
    );
    expect(textOf(folded[1])).toContain('[U1]');
    expect(textOf(folded[1])).toContain('start');
    expect(textOf(folded[2])).toBe('<spine_memory node_id="1.1.1">\ndid A\n</spine_memory>');
    expect(textOf(folded[3])).toContain('calling spine_close');
    expect(textOf(folded[5])).toContain('[U2]');
    expect(textOf(folded[5])).toContain('after');
    expect(textOf(folded[6])).toContain('<spine_status');
    expect(textOf(folded[6])).toContain('cursor="1.1"');
  });

  it('carries the cursor and parent goal in the status line without a window reading', () => {
    const folded = foldMessages(buildClosedNodeHistory());

    const status = textOf(folded.find((m) => textOf(m).includes('<spine_status')));
    expect(status).toContain('cursor="1.1"');
    expect(status).toContain('summary="startup"');
    expect(status).toContain('parent="1"');
    expect(status).toContain('parent_summary="root epoch 1"');
    expect(status).not.toContain('context_left');
  });

  it('estimates raw and projected context in the status line, projected below raw after a fold', () => {
    const folded = foldMessages(buildClosedNodeHistory());

    const status = textOf(folded.find((m) => textOf(m).includes('<spine_status')));
    const raw = Number(/ raw_context="~(\d+)"/.exec(status)?.[1]);
    const projected = Number(/ projected_context="~(\d+)"/.exec(status)?.[1]);
    const cursor = Number(/ cursor_context="~(\d+)"/.exec(status)?.[1]);
    expect(raw).toBeGreaterThan(0);
    expect(projected).toBeGreaterThan(0);
    expect(projected).toBeLessThan(raw);
    expect(cursor).toBe(raw);
  });

  it('reads cursor_context as the estimate of the span since the cursor opened', () => {
    const messages = [
      userMessage('start'),
      assistantText('earlier work '.repeat(40)),
      assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'task A' })),
      spineAcceptedReceipt('c_open'),
      assistantText('working'),
    ];

    const folded = foldMessages(messages);
    const status = textOf(folded.find((m) => textOf(m).includes('<spine_status')));
    const cursor = Number(/ cursor_context="~(\d+)"/.exec(status)?.[1]);
    const raw = Number(/ raw_context="~(\d+)"/.exec(status)?.[1]);
    expect(cursor).toBeGreaterThan(0);
    expect(cursor).toBeLessThan(raw);
  });

  it('derives context_left from the window passed to the fold', () => {
    const folded = foldMessages(buildClosedNodeHistory(), 100_000);

    const status = textOf(folded.find((m) => textOf(m).includes('<spine_status')));
    expect(status).toContain('context_left="~100K"');
  });

  it('flattens nested closed nodes into per-node memory slots', () => {
    const folded = foldMessages(buildNestedClosedHistory());

    const memoryMessages = folded.filter((m) => textOf(m).includes('<spine_memory'));
    expect(memoryMessages).toHaveLength(2);
    expect(textOf(memoryMessages[0])).toBe(
      '<spine_memory node_id="1.1.1.1">\nchild mem\n</spine_memory>',
    );
    expect(textOf(memoryMessages[1])).toBe(
      '<spine_memory node_id="1.1.1">\nparent mem\n</spine_memory>',
    );
  });

  it('replaces each sibling of a next-chain with its own memory', () => {
    const messages = [
      userMessage('start'),
      assistantToolCall('o1', 'spine_open', JSON.stringify({ summary: 'task A' })),
      spineAcceptedReceipt('o1'),
      assistantText('A body'),
      assistantToolCall('n1', 'spine_next', JSON.stringify({ summary: 'task B', memory: 'mem A' })),
      spineAcceptedReceipt('n1'),
      assistantText('B body'),
      assistantToolCall('n2', 'spine_next', JSON.stringify({ summary: 'task C', memory: 'mem B' })),
      spineAcceptedReceipt('n2'),
      assistantText('C body'),
      assistantToolCall('c1', 'spine_close', JSON.stringify({ memory: 'mem C' })),
      spineAcceptedReceipt('c1'),
      userMessage('finished'),
    ];

    const folded = foldMessages(messages);
    const memories = folded.filter((m) => textOf(m).startsWith('<spine_memory node_id="'));
    expect(memories).toHaveLength(3);
    expect(textOf(memories[0])).toContain('node_id="1.1.1"');
    expect(textOf(memories[0])).toContain('mem A');
    expect(textOf(memories[1])).toContain('node_id="1.1.2"');
    expect(textOf(memories[1])).toContain('mem B');
    expect(textOf(memories[2])).toContain('node_id="1.1.3"');
    expect(textOf(memories[2])).toContain('mem C');
    for (const body of ['A body', 'B body', 'C body']) {
      expect(folded.some((m) => textOf(m).includes(body))).toBe(false);
    }
    expect(textOf(folded[1])).toContain('[U1] start');
    expect(textOf(folded[7])).toContain('[U2] finished');
  });

  it('flattens a closed subtree into per-node memory slots, children first', () => {
    const messages = [
      userMessage('start'),
      assistantToolCall('po', 'spine_open', JSON.stringify({ summary: 'parent' })),
      spineAcceptedReceipt('po'),
      assistantToolCall('co', 'spine_open', JSON.stringify({ summary: 'task A' })),
      spineAcceptedReceipt('co'),
      assistantText('A body'),
      assistantToolCall('n1', 'spine_next', JSON.stringify({ summary: 'task B', memory: 'mem A' })),
      spineAcceptedReceipt('n1'),
      assistantText('B body'),
      assistantToolCall('n2', 'spine_next', JSON.stringify({ summary: 'task C', memory: 'mem B' })),
      spineAcceptedReceipt('n2'),
      assistantText('C body'),
      assistantToolCall('cc', 'spine_close', JSON.stringify({ memory: 'mem C' })),
      spineAcceptedReceipt('cc'),
      assistantText('parent tail'),
      assistantToolCall('pc', 'spine_close', JSON.stringify({ memory: 'mem parent' })),
      spineAcceptedReceipt('pc'),
      userMessage('final'),
    ];

    const folded = foldMessages(messages);
    const memories = folded.filter((m) => textOf(m).startsWith('<spine_memory node_id="'));
    expect(memories).toHaveLength(4);
    expect(textOf(memories[0])).toBe('<spine_memory node_id="1.1.1.1">\nmem A\n</spine_memory>');
    expect(textOf(memories[1])).toBe('<spine_memory node_id="1.1.1.2">\nmem B\n</spine_memory>');
    expect(textOf(memories[2])).toBe('<spine_memory node_id="1.1.1.3">\nmem C\n</spine_memory>');
    expect(textOf(memories[3])).toBe('<spine_memory node_id="1.1.1">\nmem parent\n</spine_memory>');
    for (const body of ['A body', 'B body', 'C body', 'parent tail']) {
      expect(folded.some((m) => textOf(m).includes(body))).toBe(false);
    }
    expect(textOf(folded[1])).toContain('[U1] start');
    expect(textOf(folded[8])).toContain('[U2] final');
  });

  it('drops messages before the current epoch after a root compact', () => {
    const messages = [
      ...buildClosedNodeHistory(),
      createCompactionSummaryMessage(buildCompactionSummaryText('epoch summary')),
      userMessage('new epoch work'),
    ];

    const folded = foldMessages(messages);
    expect(textOf(folded[0])).toBe(buildCompactionSummaryText('epoch summary'));
    expect(folded.some((m) => textOf(m).includes('did A'))).toBe(false);
    expect(folded.some((m) => textOf(m).includes('new epoch work'))).toBe(true);
  });

  it('skips nodes closed before the epoch boundary and still folds post-epoch nodes', () => {
    const messages = [
      ...buildClosedNodeHistory(),
      createCompactionSummaryMessage(buildCompactionSummaryText('epoch summary')),
      userMessage('new epoch work'),
      assistantToolCall('b_open', 'spine_open', JSON.stringify({ summary: 'task B' })),
      spineAcceptedReceipt('b_open'),
      assistantText('B working'),
      assistantToolCall('b_close', 'spine_close', JSON.stringify({ memory: 'did B' })),
      spineAcceptedReceipt('b_close'),
      userMessage('tail'),
    ];

    const folded = foldMessages(messages);
    expect(textOf(folded[0])).toBe(buildCompactionSummaryText('epoch summary'));
    expect(folded.some((m) => textOf(m).includes('did A'))).toBe(false);
    const memories = folded.filter((m) => textOf(m).includes('<spine_memory'));
    expect(memories).toHaveLength(1);
    expect(textOf(memories[0])).toContain('did B');
    expect(folded.some((m) => textOf(m).includes('B working'))).toBe(false);
    expect(folded.some((m) => textOf(m).includes('new epoch work'))).toBe(true);
    expect(folded.some((m) => textOf(m).includes('tail'))).toBe(true);
  });

  it('keeps request anchors stable across an epoch boundary', () => {
    const messages = [
      userMessage('old request'),
      assistantToolCall('o1', 'spine_open', JSON.stringify({ summary: 'epoch-1 task' })),
      spineAcceptedReceipt('o1'),
      assistantText('epoch-1 body'),
      assistantToolCall('c1', 'spine_close', JSON.stringify({ memory: 'epoch-1 mem' })),
      spineAcceptedReceipt('c1'),
      createCompactionSummaryMessage(buildCompactionSummaryText('epoch summary')),
      userMessage('new epoch request'),
      assistantToolCall('o2', 'spine_open', JSON.stringify({ summary: 'epoch-2 task' })),
      spineAcceptedReceipt('o2'),
      assistantText('epoch-2 body'),
      assistantToolCall('c2', 'spine_close', JSON.stringify({ memory: 'epoch-2 mem' })),
      spineAcceptedReceipt('c2'),
      userMessage('tail'),
    ];

    const folded = foldMessages(messages);
    const texts = folded.map(textOf);
    expect(texts[0]).toBe(buildCompactionSummaryText('epoch summary'));
    expect(texts[1]).toBe('<spine_node id="2.1" summary="startup" status="live" />');
    expect(texts[2]).toContain('[U2] new epoch request');
    expect(texts.some((line) => line.includes('[U3] tail'))).toBe(true);
    expect(texts.at(-1)).toContain('cursor="2.1"');
  });

  it('marks an open node boundary with a spine_node landmark before its carrier', () => {
    const messages = [
      userMessage('start'),
      assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'task A' })),
      spineAcceptedReceipt('c_open'),
      assistantText('working'),
      userMessage('after'),
    ];

    const folded = foldMessages(messages);
    const texts = folded.map(textOf);
    expect(texts.slice(0, 3)).toEqual([
      '<spine_node id="1.1" summary="startup" status="opened" />',
      '[U1] start',
      '<spine_node id="1.1.1" summary="task A" status="live" />',
    ]);
    expect(texts[3]).toContain('calling spine_open');
    expect(texts[4]).toBe(ACCEPTED_OUTPUT);
    expect(texts[5]).toBe('working');
    expect(texts[6]).toBe('[U2] after');
    expect(texts.at(-1)).toContain('<spine_status');
    expect(texts.at(-1)).toContain('cursor="1.1.1"');
  });

  it('preserves media parts of a user request inside a closed span', () => {
    const messages = [
      userMessage('start'),
      assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'task A' })),
      spineAcceptedReceipt('c_open'),
      {
        role: 'user',
        content: [
          { type: 'image_url', imageUrl: { url: 'https://example.com/pic.png' } },
          { type: 'text', text: 'look at this' },
        ],
        toolCalls: [],
        origin: { kind: 'user' },
      } satisfies ContextMessage,
      assistantText('working'),
      assistantToolCall('c_close', 'spine_close', JSON.stringify({ memory: 'did A' })),
      spineAcceptedReceipt('c_close'),
      userMessage('after'),
    ];

    const folded = foldMessages(messages);
    const surviving = folded.find((m) => m.content.some((part) => part.type === 'image_url'));
    expect(surviving?.role).toBe('user');
    expect(surviving?.content).toEqual([
      { type: 'image_url', imageUrl: { url: 'https://example.com/pic.png' } },
      { type: 'text', text: '[U2] look at this' },
    ]);
  });

  it('escapes the node summary inside the spine_node landmark', () => {
    const messages = [
      userMessage('start'),
      assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'a & "b" <c>' })),
      spineAcceptedReceipt('c_open'),
    ];

    const folded = foldMessages(messages);
    expect(
      folded.some((m) =>
        textOf(m).includes(
          '<spine_node id="1.1.1" summary="a &amp; &quot;b&quot; &lt;c&gt;" status="live" />',
        ),
      ),
    ).toBe(true);
  });
});

describe('spine tree view', () => {
  it('projects an empty transcript as the synthetic root epoch and startup node alone', () => {
    expect(spineTreeViewFromState(deriveSpineState([]))).toStrictEqual({
      nodes: [nodeView('1', 'root epoch 1', false, [nodeView('1.1', 'startup', false)])],
    });
  });

  it('projects open and closed nodes in open order and skips rejected transitions', () => {
    const state = deriveSpineState(buildNextChainHistory());

    expect(spineTreeViewFromState(state)).toStrictEqual({
      nodes: [
        nodeView('1', 'root epoch 1', false, [
          nodeView('1.1', 'startup', false, [
            nodeView('1.1.1', 'task A', true),
            nodeView('1.1.2', 'task B', true),
            nodeView('1.1.3', 'task C', false),
          ]),
        ]),
      ],
    });
  });

  it('marks a superseded root epoch closed while the current epoch stays open', () => {
    const state = deriveSpineState([
      userMessage('start'),
      createCompactionSummaryMessage(buildCompactionSummaryText('epoch summary')),
      userMessage('new epoch work'),
    ]);

    const view = spineTreeViewFromState(state);
    expect(view.nodes.map((node) => `${node.id}:${String(node.closed)}`)).toEqual([
      '1:true',
      '2:false',
    ]);
  });

  it('renders the tree with the cursor marker through renderTree', () => {
    const state = deriveSpineState(buildNextChainHistory());

    const rendered = renderTree({
      cursorId: state.openStack.at(-1),
      rootIds: epochRootIds(state),
      resolve: (id) => spineNodeViewFromState(state, id),
    });

    const lines = rendered.split('\n');
    expect(lines.map((line) => /^(\S+) \[/.exec(line.trimStart())?.[1])).toEqual([
      '1',
      '1.1',
      '1.1.1',
      '1.1.2',
      '1.1.3',
    ]);
    expect(lines.find((line) => line.trimStart().startsWith('1.1.1 ['))).toContain('[closed]');
    expect(lines.find((line) => line.trimStart().startsWith('1.1.3 ['))).toContain(
      '[open] <== cursor',
    );
    expect(lines.find((line) => line.trimStart().startsWith('1.1.3 ['))).toContain('task C');
  });

  it('renders token costs and archive paths from the optional view inputs', () => {
    const messages = buildNextChainHistory();
    const state = deriveSpineState(messages);

    const bare = spineTreeViewFromState(state);
    for (const id of ['1', '1.1', '1.1.1', '1.1.2', '1.1.3']) {
      const node = flattenViewNodes(bare).find((candidate) => candidate.id === id);
      expect(node?.tokenCost).toBeUndefined();
      expect(node?.archivePath).toBeUndefined();
    }

    const view = spineTreeViewFromState(state, {
      measure: (node) => {
        if (node.openedAt < 0 || node.openedAt >= messages.length) return undefined;
        const end = Math.min((node.closedAt ?? messages.length - 1) + 1, messages.length);
        return estimateTokensForMessages(messages.slice(node.openedAt, end));
      },
      resolveArchivePath: (id, epoch, closed) =>
        epoch || !closed ? undefined : `archive-${id}.md`,
    });
    const closed = flattenViewNodes(view).find((candidate) => candidate.id === '1.1.1');
    expect(closed?.tokenCost).toBeGreaterThan(0);
    expect(closed?.archivePath).toBe('archive-1.1.1.md');
    expect(flattenViewNodes(view).find((candidate) => candidate.id === '1')?.tokenCost).toBeUndefined();

    const rendered = renderTree({
      cursorId: state.openStack.at(-1),
      rootIds: epochRootIds(state),
      resolve: (id) => spineNodeViewFromState(state, id, {
        measure: (node) => (node.openedAt < 0 ? undefined : 1_400),
        resolveArchivePath: (id, epoch, closed) =>
          epoch || !closed ? undefined : `archive-${id}.md`,
      }),
    });
    const closedLine = rendered.split('\n').find((line) => line.trimStart().startsWith('1.1.1 ['));
    expect(closedLine).toContain('[closed, ~1.4K, archive: archive-1.1.1.md]');
  });
});

function buildClosedNodeHistory(): ContextMessage[] {
  return [
    userMessage('start'),
    assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'task A' })),
    spineAcceptedReceipt('c_open'),
    assistantText('working'),
    assistantToolCall('c_close', 'spine_close', JSON.stringify({ memory: 'did A' })),
    spineAcceptedReceipt('c_close'),
    userMessage('after'),
  ];
}

function buildNestedClosedHistory(): ContextMessage[] {
  return [
    userMessage('start'),
    assistantToolCall('c_parent_open', 'spine_open', JSON.stringify({ summary: 'parent' })),
    spineAcceptedReceipt('c_parent_open'),
    assistantToolCall('c_child_open', 'spine_open', JSON.stringify({ summary: 'child' })),
    spineAcceptedReceipt('c_child_open'),
    assistantToolCall('c_child_close', 'spine_close', JSON.stringify({ memory: 'child mem' })),
    spineAcceptedReceipt('c_child_close'),
    assistantToolCall('c_parent_close', 'spine_close', JSON.stringify({ memory: 'parent mem' })),
    spineAcceptedReceipt('c_parent_close'),
  ];
}

function buildNextChainHistory(): ContextMessage[] {
  return [
    userMessage('start'),
    assistantToolCall('o1', 'spine_open', JSON.stringify({ summary: 'task A' })),
    spineAcceptedReceipt('o1'),
    assistantToolCall('c1', 'spine_close', JSON.stringify({ memory: 'did A' })),
    spineAcceptedReceipt('c1'),
    assistantToolCall('o2', 'spine_open', JSON.stringify({ summary: 'task B' })),
    spineAcceptedReceipt('o2'),
    assistantToolCall('n1', 'spine_next', JSON.stringify({ summary: 'task C', memory: 'did B' })),
    spineAcceptedReceipt('n1'),
    assistantToolCall('o3', 'spine_open', JSON.stringify({ summary: 'task D' })),
    spineRejectedReceipt('o3'),
    assistantToolCall('c2', 'spine_close', JSON.stringify({ memory: 'did C' })),
    spineRejectedReceipt('c2'),
  ];
}

function nodeView(
  id: string,
  summary: string,
  closed: boolean,
  children: readonly SpineTreeNodeView[] = [],
): SpineTreeNodeView {
  return { id, summary, closed, archivePath: undefined, tokenCost: undefined, children };
}

function flattenViewNodes(view: SpineTreeView): SpineTreeNodeView[] {
  const out: SpineTreeNodeView[] = [];
  const walk = (nodes: readonly SpineTreeNodeView[]): void => {
    for (const node of nodes) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(view.nodes);
  return out;
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

function toolReceipt(toolCallId: string, text: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text }],
    toolCalls: [],
    toolCallId,
  };
}

function spineAcceptedReceipt(toolCallId: string): ContextMessage {
  return toolReceipt(toolCallId, ACCEPTED_OUTPUT);
}

function spineRejectedReceipt(toolCallId: string): ContextMessage {
  return { ...toolReceipt(toolCallId, 'rejected: nope'), isError: true };
}

function compactionSummaryTextMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function textOf(
  message: { content?: readonly { type: string; text?: string }[] } | undefined,
): string {
  return (
    message?.content?.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('') ?? ''
  );
}
