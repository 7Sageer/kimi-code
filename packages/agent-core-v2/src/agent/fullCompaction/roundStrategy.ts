import type { ContextMessage } from '#/agent/contextMemory/types';

import type { CompactionResult } from './types';

export interface CompactionApplyInput {
  readonly summary: string;
  readonly originalHistory: readonly ContextMessage[];
  readonly tokensBefore: number;
  readonly droppedCount?: number;
  readonly summaryOutputTokens?: number;
  readonly requestOverheadTokens: number;
}

export interface CompactionRoundStrategy {
  scopeHistory(history: readonly ContextMessage[]): readonly ContextMessage[];
  postProcessSummary(summary: string): Promise<string> | string;
  applyResult(input: CompactionApplyInput): Promise<CompactionResult> | CompactionResult;
}
