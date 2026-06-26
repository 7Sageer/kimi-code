
import {
  type Message
} from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { DefaultCompactionStrategy } from '../../../src/agent/compaction';
import { estimateTokensForMessages } from '../../../src/utils/tokens';

describe('DefaultCompactionStrategy', () => {
  it('compacts the entire history when it fits within the window', () => {
    const strategy = testCompactionStrategy();
    const messages = [
      textMessage('user', 'old user'),
      textMessage('assistant', 'old assistant'),
      textMessage('user', 'recent user'),
      textMessage('assistant', `recent assistant ${'x'.repeat(1_200)}`),
    ];

    // Full replacement: when the whole history fits in the model window, the
    // strategy compacts everything and keeps no recent suffix, matching
    // Claude's default `/compact` — even though the trailing exchange itself
    // is oversized.
    expect(strategy.computeCompactCount(messages, 'auto')).toBe(messages.length);
    expect(strategy.computeCompactCount(messages, 'manual')).toBe(messages.length);
  });

  it('compacts the entire history even when it ends with user messages', () => {
    const strategy = testCompactionStrategy();
    const messages = [
      textMessage('user', 'old user'),
      textMessage('assistant', 'old assistant'),
      textMessage('user', 'pending user one'),
      textMessage('user', 'pending user two'),
    ];

    expect(strategy.computeCompactCount(messages, 'auto')).toBe(messages.length);
  });

  it('returns 0 for an empty history', () => {
    const strategy = testCompactionStrategy();
    expect(strategy.computeCompactCount([], 'auto')).toBe(0);
    expect(strategy.computeCompactCount([], 'manual')).toBe(0);
  });

  it('compacts the entire history even when the trailing tool exchange is unresolved', () => {
    const strategy = testCompactionStrategy();
    const messages: Message[] = [
      textMessage('user', 'inspect'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_a', name: 'Lookup', arguments: '{}' }],
      },
    ];

    // No safe intermediate split exists, but the whole history fits in the
    // window, so full replacement compacts everything. The unresolved exchange
    // is trimmed from the summarizer prompt separately (see full.ts).
    expect(strategy.computeCompactCount(messages, 'auto')).toBe(messages.length);
  });

  it('fits to a safe prefix without splitting inside a parallel tool exchange', () => {
    const maxSize = 1_000;
    const strategy = testCompactionStrategy(maxSize);
    const bigUser = (label: string): Message => textMessage('user', `${label} ${'x'.repeat(1_200)}`);
    const bigAssistant = (label: string): Message =>
      textMessage('assistant', `${label} ${'x'.repeat(1_200)}`);
    const messages: Message[] = [
      bigUser('old user'),
      bigAssistant('old assistant'),
      textMessage('user', 'run both tools'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_a', name: 'Lookup', arguments: '{}' },
          { type: 'function', id: 'call_b', name: 'Lookup', arguments: '{}' },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: `a ${'x'.repeat(2_000)}` }],
        toolCalls: [],
        toolCallId: 'call_a',
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: `b ${'x'.repeat(2_000)}` }],
        toolCalls: [],
        toolCallId: 'call_b',
      },
      bigUser('next prompt'),
    ];

    const count = strategy.computeCompactCount(messages, 'auto');

    // The history exceeds the window, so the strategy falls back to the
    // largest safe prefix that fits; the remainder stays as a suffix.
    expect(count).toBeLessThan(messages.length);
    expect(count).toBeGreaterThan(0);
    expect(estimateTokensForMessages(messages.slice(0, count))).toBeLessThanOrEqual(maxSize);
    // The split never lands inside the parallel tool exchange: it neither
    // cuts between tool_a and tool_b (which would orphan tool_b) nor after the
    // assistant that still has pending tool calls.
    expect(count).not.toBe(4);
    expect(count).not.toBe(5);
    // The prefix ends at a safe boundary: not after a user message, not after
    // an assistant with pending tool calls, and not before a tool result.
    const cutMessage = messages[count - 1]!;
    expect(cutMessage.role).not.toBe('user');
    expect(cutMessage.role === 'assistant' && cutMessage.toolCalls.length > 0).toBe(false);
    expect(messages[count]?.role).not.toBe('tool');
  });

  it('shrinks auto compaction input to fit the model window', () => {
    const maxSize = 1_000;
    const strategy = testCompactionStrategy(maxSize);
    const messages = Array.from({ length: 30 }, (_, i) =>
      textMessage('assistant', `message ${i} ${'x'.repeat(400)}`),
    );

    const count = strategy.computeCompactCount(messages, 'auto');

    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(messages.length);
    expect(estimateTokensForMessages(messages.slice(0, count))).toBeLessThanOrEqual(maxSize);
    expect(estimateTokensForMessages(messages.slice(0, count + 1))).toBeGreaterThan(maxSize);
  });

  it('shrinks manual compaction input to fit the model window', () => {
    const maxSize = 1_000;
    const strategy = testCompactionStrategy(maxSize);
    const messages = Array.from({ length: 30 }, (_, i) =>
      textMessage('assistant', `message ${i} ${'x'.repeat(400)}`),
    );

    const count = strategy.computeCompactCount(messages, 'manual');

    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(messages.length);
    expect(estimateTokensForMessages(messages.slice(0, count))).toBeLessThanOrEqual(maxSize);
    expect(estimateTokensForMessages(messages.slice(0, count + 1))).toBeGreaterThan(maxSize);
  });

  it('reserves response context by default before the ratio threshold is reached', () => {
    const strategy = new DefaultCompactionStrategy(() => 256_000);

    expect(strategy.shouldCompact(210_000)).toBe(true);
    expect(strategy.shouldBlock(210_000)).toBe(true);
  });

  it('ignores reserved context when the reserve is not smaller than the model window', () => {
    const strategy = new DefaultCompactionStrategy(() => 32_000, {
      triggerRatio: 0.85,
      blockRatio: 0.85,
      reservedContextSize: 50_000,
      maxCompactionPerTurn: 3,
      minOverflowReductionRatio: 0.05,
    });

    expect(strategy.shouldCompact(1)).toBe(false);
    expect(strategy.shouldBlock(1)).toBe(false);
    expect(strategy.shouldCompact(28_000)).toBe(true);
    expect(strategy.shouldBlock(28_000)).toBe(true);
  });
});

function testCompactionStrategy(maxSize: number = 1_000): DefaultCompactionStrategy {
  return new DefaultCompactionStrategy(() => maxSize, {
    triggerRatio: 0.85,
    blockRatio: 0.85,
    reservedContextSize: 0,
    maxCompactionPerTurn: 3,
    minOverflowReductionRatio: 0.05,
  });
}

function overflowOnlyCompactionStrategy(maxSize: number = 14): DefaultCompactionStrategy {
  return new DefaultCompactionStrategy(() => maxSize, {
    triggerRatio: Infinity,
    blockRatio: Infinity,
    reservedContextSize: 0,
    maxCompactionPerTurn: 3,
    minOverflowReductionRatio: 0.05,
  });
}

function textMessage(role: 'user' | 'assistant', text: string): Message {
  return {
    role,
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}
