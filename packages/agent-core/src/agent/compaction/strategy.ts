import type { Message } from "@moonshot-ai/kosong";
import { estimateTokensForMessage } from "../../utils/tokens";
import type { CompactionSource } from "./types";

export interface CompactionConfig {
  triggerRatio: number;
  blockRatio: number;
  reservedContextSize: number;
  maxCompactionPerTurn: number;
  minOverflowReductionRatio: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerRatio: 0.85,
  blockRatio: 0.85, // Same as triggerRatio to disable async compaction
  reservedContextSize: 50_000,
  maxCompactionPerTurn: Infinity,
  minOverflowReductionRatio: 0.05,
};

export interface CompactionStrategy {
  shouldCompact(usedSize: number): boolean;
  shouldBlock(usedSize: number): boolean;
  computeCompactCount(messages: readonly Message[], source: CompactionSource): number;
  reduceCompactOnOverflow(messages: readonly Message[]): number;
  readonly checkAfterStep: boolean;
  readonly maxCompactionPerTurn: number;
}

export class DefaultCompactionStrategy implements CompactionStrategy {
  constructor(
    protected readonly maxSizeProvider: () => number,
    protected readonly config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
  ) { }

  protected get maxSize(): number {
    return this.maxSizeProvider();
  }

  shouldCompact(usedSize: number): boolean {
    if (this.maxSize <= 0) return false;
    return (
      usedSize >= this.maxSize * this.config.triggerRatio ||
      this.shouldUseReservedContext(usedSize)
    );
  }

  shouldBlock(usedSize: number): boolean {
    if (this.maxSize <= 0) return false;
    return (
      usedSize >= this.maxSize * this.config.blockRatio ||
      this.shouldUseReservedContext(usedSize)
    );
  }

  private shouldUseReservedContext(usedSize: number): boolean {
    const reservedSize = this.config.reservedContextSize;
    return reservedSize > 0 && reservedSize < this.maxSize && usedSize + reservedSize >= this.maxSize;
  }

  computeCompactCount(messages: readonly Message[], _source: CompactionSource): number {
    // Claude Code parity: compaction replaces the entire history with the
    // summary — no recent suffix is retained, matching Claude's default
    // `/compact`. If the whole history does not fit in the model window, fall
    // back to the largest safe prefix that fits; the remainder stays as a
    // suffix, mirroring Claude's prompt-too-long head truncation.
    //
    // Return value: N messages to be compacted (0 means nothing to compact).
    // LLM Input: messages.slice(0, N) + [user:instruction]
    // Preserved recent messages: messages.slice(N) (empty when everything fits)
    return this.fitCompactCountToWindow(messages, messages.length);
  }

  reduceCompactOnOverflow(messages: readonly Message[]): number {
    const minReducedSize = Math.max(
      1,
      Math.ceil(this.maxSize * this.config.minOverflowReductionRatio),
    );
    let reducedSize = 0;
    let bestN: number | undefined;

    for (let i = messages.length - 2; i > 0; i--) {
      reducedSize += estimateTokensForMessage(messages[i + 1]!);
      if (canSplitAfter(messages, i)) {
        bestN = i + 1;
        if (reducedSize >= minReducedSize) {
          return i + 1;
        }
      }
    }
    return bestN ?? messages.length;
  }

  private fitCompactCountToWindow(
    messages: readonly Message[],
    compactedCount: number,
  ): number {
    if (this.maxSize <= 0 || compactedCount <= 0) {
      return compactedCount;
    }

    let compactedSize = 0;
    for (let i = 0; i < compactedCount; i++) {
      compactedSize += estimateTokensForMessage(messages[i]!);
    }
    if (compactedSize <= this.maxSize) {
      return compactedCount;
    }

    let bestN: number | undefined;
    for (let n = compactedCount - 1; n > 0; n--) {
      compactedSize -= estimateTokensForMessage(messages[n]!);
      if (!canSplitAfter(messages, n - 1)) {
        continue;
      }
      bestN = n;
      if (compactedSize <= this.maxSize) {
        return n;
      }
    }

    return bestN ?? compactedCount;
  }

  get checkAfterStep(): boolean {
    return this.config.triggerRatio !== this.config.blockRatio;
  }

  get maxCompactionPerTurn(): number {
    return this.config.maxCompactionPerTurn;
  }
}

/**
 * Decide whether a compaction split is safe to place immediately after
 * `messages[index]`. A split is safe only when:
 *   - `messages[index]` itself is not a user message or an assistant message
 *     with pending tool calls (cutting either of those off from what follows
 *     would break the conversation), AND
 *   - the next message is not a tool result. The history is well-formed:
 *     tool results only appear after their owning `asst_w_tc` and all tool
 *     results for one exchange land consecutively before the next non-tool
 *     message. So if the suffix starts with a tool result, its `asst_w_tc`
 *     must be in the compacted prefix, which would orphan that result
 *     (e.g. splitting between tool_a and tool_b of a parallel call), AND
 *   - the compacted prefix itself does not end with an unresolved tool
 *     exchange, because pending tool results must remain in the retained tail.
 */
function canSplitAfter(messages: readonly Message[], index: number): boolean {
  const m = messages[index];
  if (m === undefined) return false;
  if (m.role === 'user') return false;
  if (m.role === 'assistant' && m.toolCalls.length > 0) return false;
  if (messages[index + 1]?.role === 'tool') return false;
  if (prefixEndsWithOpenToolExchange(messages, index)) return false;
  return true;
}

function prefixEndsWithOpenToolExchange(messages: readonly Message[], index: number): boolean {
  if (messages[index]?.role !== 'tool') return false;

  let toolResultCount = 0;
  for (let i = index; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) return false;
    if (message.role === 'tool') {
      toolResultCount++;
      continue;
    }
    return message.role === 'assistant' && message.toolCalls.length > toolResultCount;
  }
  return false;
}
