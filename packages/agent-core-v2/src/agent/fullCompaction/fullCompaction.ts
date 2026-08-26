import type {
  CompactionResult,
  CompactionSource,
} from './types';
import type { CompactionRoundStrategy } from './roundStrategy';
import { createDecorator } from "#/_base/di/instantiation";
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { Hooks } from '#/hooks';

export interface FullCompactionInput {
  readonly source: CompactionSource;
  readonly instruction?: string;
}

export interface FullCompactionTask {
  readonly abortController: AbortController;
  readonly promise: Promise<CompactionResult>;
  readonly trigger: CompactionSource;
  readonly tokenCount: number;
  readonly traceId?: string;
}

export interface IAgentFullCompactionService {
  readonly _serviceBrand: undefined;

  readonly compacting: FullCompactionTask | null;
  begin(input: FullCompactionInput): boolean;
  cancel(): void;

  registerStrategy(id: string, strategy: CompactionRoundStrategy): IDisposable;

  getEffectiveMaxContextTokens(): number;

  readonly hooks: Hooks<{
    onWillCompact: FullCompactionTask;
  }>;

  readonly onDidFinishCompaction: Event<FullCompactionTask>;
}

export const IAgentFullCompactionService = createDecorator<IAgentFullCompactionService>('agentFullCompactionService');
