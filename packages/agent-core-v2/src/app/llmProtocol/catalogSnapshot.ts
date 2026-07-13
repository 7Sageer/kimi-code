/**
 * `llmProtocol` domain (L0) — models.dev catalog snapshot seeded at startup.
 *
 * Holds the process-wide models.dev catalog snapshot that model resolution
 * uses as a capability fallback ahead of the built-in capability table.
 * `catalog` is `undefined` when the host did not embed a snapshot (dev
 * builds) or the embedded JSON failed to parse, in which case detection
 * falls back to the built-in table alone. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { Catalog } from './catalog';

export interface ICatalogSnapshot {
  readonly _serviceBrand: undefined;
  readonly catalog: Catalog | undefined;
}

export const ICatalogSnapshot: ServiceIdentifier<ICatalogSnapshot> =
  createDecorator<ICatalogSnapshot>('catalogSnapshot');

export class CatalogSnapshot implements ICatalogSnapshot {
  declare readonly _serviceBrand: undefined;

  constructor(readonly catalog: Catalog | undefined) {}
}

registerScopedService(
  LifecycleScope.App,
  ICatalogSnapshot,
  CatalogSnapshot,
  InstantiationType.Delayed,
  'llmProtocol',
);
