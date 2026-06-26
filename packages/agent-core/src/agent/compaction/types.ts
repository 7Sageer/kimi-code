import type { ContextMessage } from '../context/types';

export interface CompactionResult {
  summary: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  /**
   * Additional user messages re-injected after the summary, mirroring Claude
   * Code's post-compact attachments (recently-read files, active plan, running
   * subagents). They are appended to context after the summary message.
   */
  attachments?: readonly ContextMessage[];
}

export type CompactionSource = 'manual' | 'auto';

export interface CompactionBeginData {
  instruction?: string;
  source: CompactionSource;
}
