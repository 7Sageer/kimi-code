import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Message } from '#/kosong/contract/message';

import type { ContextMessage } from '#/agent/contextMemory/types';

declare const mediaStripSnapshotBrand: unique symbol;

export interface MediaStripSnapshot {
  readonly [mediaStripSnapshotBrand]: undefined;
}

export type ContextFold = (
  messages: readonly ContextMessage[],
) => readonly ContextMessage[];

export interface ProjectionPolicy {
  readonly structure?: 'strict';
  readonly media?: 'degraded' | { readonly strip: MediaStripSnapshot };
  readonly folds?: boolean;
}

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;

  project(
    messages: readonly ContextMessage[],
    policy?: ProjectionPolicy,
  ): readonly Message[];
  captureMediaStripSnapshot(messages: readonly ContextMessage[]): MediaStripSnapshot;
  registerFold(id: string, fold: ContextFold): IDisposable;
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
