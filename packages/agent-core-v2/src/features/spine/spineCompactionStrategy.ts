import {
  buildCompactionSummaryText,
  createCompactionSummaryMessage,
} from '#/agent/contextMemory/compactionHandoff';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type {
  CompactionApplyInput,
  CompactionRoundStrategy,
} from '#/agent/fullCompaction/roundStrategy';
import type { CompactionResult } from '#/agent/fullCompaction/types';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';

import type { IAgentSpineService } from './spine';
import { deriveSpineState } from './spineDerive';

export class SpineCompactionStrategy implements CompactionRoundStrategy {
  constructor(
    private readonly context: IAgentContextMemoryService,
    private readonly spine: IAgentSpineService,
    private readonly tokenCounting: ISessionTokenCountingService,
    private readonly scopeContext: IAgentScopeContext,
  ) {}

  scopeHistory(history: readonly ContextMessage[]): readonly ContextMessage[] {
    const state = deriveSpineState(history);
    const start = Math.min(state.epochStartAt, history.length);
    const scoped = history.slice(start);
    const summaryAt = state.epochMemoryAt;
    const priorSummary =
      summaryAt !== undefined && summaryAt < start ? history[summaryAt] : undefined;
    return priorSummary === undefined ? scoped : [priorSummary, ...scoped];
  }

  postProcessSummary(summary: string): string {
    return summary;
  }

  async applyResult(input: CompactionApplyInput): Promise<CompactionResult> {
    const contextSummary = buildCompactionSummaryText(input.summary);
    const summaryMessage = createCompactionSummaryMessage(contextSummary);
    const summaryAt = this.context.get().length;
    const foldedMessages = this.context.get().slice(0, summaryAt);
    const epoch = this.spine.currentState().rootEpoch + 1;
    const epochStartAt = summaryAt + 1;
    this.context.append(summaryMessage);
    const tokensAfter = estimateTokensForMessages([summaryMessage]);
    await this.spine.archiveEpochRoot({
      epoch,
      epochStartAt,
      epochMemoryAt: summaryAt,
      summary: input.summary,
      messages: foldedMessages,
    });
    this.tokenCounting.rebase(this.scopeContext.agentContext, {
      length: epochStartAt,
      tokens: tokensAfter,
      measured: false,
    });
    return {
      summary: input.summary,
      contextSummary,
      compactedCount: input.originalHistory.length,
      tokensBefore: input.tokensBefore,
      tokensAfter,
      keptUserMessageCount: 0,
      droppedCount: input.droppedCount,
    };
  }
}
