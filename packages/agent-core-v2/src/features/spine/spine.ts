import { createDecorator } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';

import type { SpineEpochArchiveInput } from './spineArchive';
import type { SpineState } from './spineState';

export const SPINE_TOOL_OPEN = 'spine_open';
export const SPINE_TOOL_CLOSE = 'spine_close';
export const SPINE_TOOL_NEXT = 'spine_next';
export const SPINE_TOOL_TREE = 'spine_tree';

export const SPINE_TOOL_NAMES = [
  SPINE_TOOL_OPEN,
  SPINE_TOOL_CLOSE,
  SPINE_TOOL_NEXT,
  SPINE_TOOL_TREE,
] as const;

export interface SpineTransitionAccepted {
  readonly accepted: true;
}

export interface SpineTransitionRejected {
  readonly accepted: false;
  readonly reason: string;
}

export type SpineTransitionResult = SpineTransitionAccepted | SpineTransitionRejected;

export interface IAgentSpineService {
  readonly _serviceBrand: undefined;

  readonly enabled: boolean;

  acceptOpen(summary: string): SpineTransitionResult;
  acceptClose(memory: string): SpineTransitionResult;
  acceptNext(summary: string, memory: string): SpineTransitionResult;

  archiveEpochRoot(input: SpineEpochArchiveInput): Promise<string | undefined>;

  renderTree(): string;

  fold(messages: readonly ContextMessage[]): readonly ContextMessage[];

  currentState(): SpineState;
}

export const IAgentSpineService = createDecorator<IAgentSpineService>('agentSpineService');
