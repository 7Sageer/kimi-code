import {
  COMPACTION_SUMMARY_PREFIX,
  isCompactionSummaryMessage,
} from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';

import { SPINE_TOOL_CLOSE, SPINE_TOOL_NEXT, SPINE_TOOL_OPEN } from './spine';
import type { SpineNode, SpineState } from './spineState';
import {
  childNodeId,
  epochStartupNodeId,
  isRootEpoch,
  nextChildIndex,
  parentNodeId,
  SPINE_VOID_OPENED_AT,
} from './spineTree';
import { ACCEPTED_OUTPUT } from './tools/controlResult';

export function deriveSpineState(messages: readonly ContextMessage[]): SpineState {
  const accepted = collectAcceptedCallIds(messages);
  const nodes: Record<string, SpineNode> = {};
  let openStack: readonly string[] = [];
  let rootEpoch = 0;
  let epochStartAt = 0;
  let epochMemoryAt: number | undefined;

  function openEpoch(epoch: number, startupOpenedAt: number): void {
    const epochId = String(epoch);
    const startupId = epochStartupNodeId(epoch);
    nodes[epochId] = {
      id: epochId,
      summary: `root epoch ${String(epoch)}`,
      openedAt: SPINE_VOID_OPENED_AT,
      children: [startupId],
    };
    nodes[startupId] = {
      id: startupId,
      summary: 'startup',
      openedAt: startupOpenedAt,
      children: [],
    };
    openStack = [epochId, startupId];
    rootEpoch = epoch;
  }

  function openNode(summary: string, openedAt: number): void {
    const parentId = openStack.at(-1);
    if (parentId === undefined) return;
    const parent = nodes[parentId];
    if (parent === undefined || parent.closedAt !== undefined) return;
    const trimmed = summary.trim();
    if (trimmed.length === 0) return;
    const id = childNodeId(parentId, nextChildIndex(parent.children));
    nodes[id] = { id, summary: trimmed, openedAt, children: [] };
    nodes[parentId] = { ...parent, children: [...parent.children, id] };
    openStack = [...openStack, id];
  }

  function closeNode(memory: string, carrierAt: number): void {
    const id = openStack.at(-1);
    if (id === undefined || isRootEpoch(id)) return;
    const node = nodes[id];
    if (node === undefined || node.closedAt !== undefined) return;
    const trimmed = memory.trim();
    if (trimmed.length === 0) return;
    const closedAt = Math.max(carrierAt - 1, node.openedAt);
    nodes[id] = { ...node, closedAt, memory: trimmed };
    openStack = openStack.slice(0, -1);
  }

  function nextNode(summary: string, memory: string, carrierAt: number): void {
    const closedId = openStack.at(-1);
    if (closedId === undefined || isRootEpoch(closedId)) return;
    const closing = nodes[closedId];
    if (closing === undefined || closing.closedAt !== undefined) return;
    const trimmedSummary = summary.trim();
    const trimmedMemory = memory.trim();
    if (trimmedSummary.length === 0 || trimmedMemory.length === 0) return;
    const parentId = parentNodeId(closedId);
    if (parentId === null) return;
    const parent = nodes[parentId];
    if (parent === undefined) return;
    const closedAt = Math.max(carrierAt - 1, closing.openedAt);
    const openedId = childNodeId(parentId, nextChildIndex(parent.children));
    nodes[closedId] = {
      ...closing,
      closedAt,
      memory: trimmedMemory,
    };
    nodes[openedId] = {
      id: openedId,
      summary: trimmedSummary,
      openedAt: closedAt + 1,
      children: [],
    };
    nodes[parentId] = { ...parent, children: [...parent.children, openedId] };
    openStack = [...openStack.slice(0, -1), openedId];
  }

  openEpoch(1, 0);
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined) continue;
    if (isEpochBoundary(message)) {
      openEpoch(rootEpoch + 1, i + 1);
      epochStartAt = i + 1;
      epochMemoryAt = i;
      continue;
    }
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (!accepted.has(call.id)) continue;
      const args = parseTransitionArgs(call.arguments);
      if (args === undefined) continue;
      if (call.name === SPINE_TOOL_OPEN) {
        openNode(args.summary, i);
      } else if (call.name === SPINE_TOOL_CLOSE) {
        closeNode(args.memory, i);
      } else if (call.name === SPINE_TOOL_NEXT) {
        nextNode(args.summary, args.memory, i);
      }
    }
  }

  return { nodes, openStack, rootEpoch, epochStartAt, epochMemoryAt };
}

interface SpineTransitionArgs {
  readonly summary: string;
  readonly memory: string;
}

function parseTransitionArgs(raw: string | null | undefined): SpineTransitionArgs | undefined {
  if (raw === undefined || raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const summary = record['summary'];
  const memory = record['memory'];
  return {
    summary: typeof summary === 'string' ? summary : '',
    memory: typeof memory === 'string' ? memory : '',
  };
}

function collectAcceptedCallIds(messages: readonly ContextMessage[]): ReadonlySet<string> {
  const spineCallIds = new Set<string>();
  for (const message of messages) {
    if (message === undefined || message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (isSpineTransitionTool(call.name)) spineCallIds.add(call.id);
    }
  }
  const accepted = new Set<string>();
  for (const message of messages) {
    if (message === undefined || message.role !== 'tool') continue;
    const callId = message.toolCallId;
    if (callId === undefined || !spineCallIds.has(callId)) continue;
    if (message.isError === true) continue;
    if (messageText(message) === ACCEPTED_OUTPUT) accepted.add(callId);
  }
  return accepted;
}

function isSpineTransitionTool(name: string): boolean {
  return name === SPINE_TOOL_OPEN || name === SPINE_TOOL_CLOSE || name === SPINE_TOOL_NEXT;
}

function isEpochBoundary(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  if (isCompactionSummaryMessage(message)) return true;
  if (message.origin !== undefined) return false;
  return messageText(message).startsWith(COMPACTION_SUMMARY_PREFIX);
}

function messageText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}
