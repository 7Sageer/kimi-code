import { getProviderModelCapability } from '@moonshot-ai/kosong';

import type { KimiConfig, ModelAlias, ProviderConfig } from './schema';

const ALWAYS_THINKING_CAPABILITY = 'always_thinking';

/**
 * Enrich runtime model aliases with the `always_thinking` capability detected
 * from kosong's built-in model knowledge (e.g. `claude-fable-5`, whose
 * thinking cannot be turned off), so UIs reading `models.<alias>.capabilities`
 * see it without the user declaring it by hand.
 *
 * Runtime-only, same contract as the env-synthesized model in
 * `loadRuntimeConfig`: write-back paths re-read the config file from disk, so
 * detected capabilities are never persisted. Catalog-declared models get the
 * same capability written into their alias at `provider catalog add` time
 * instead (see `always_reasoning` in the kosong catalog schema).
 */
export function applyDetectedModelCapabilities(config: KimiConfig): KimiConfig {
  const models = config.models;
  if (models === undefined) return config;

  let changed = false;
  const enriched: Record<string, ModelAlias> = {};
  for (const [alias, model] of Object.entries(models)) {
    const declared = model.capabilities ?? [];
    if (
      declared.some((c) => c.trim().toLowerCase() === ALWAYS_THINKING_CAPABILITY) ||
      !detectsAlwaysThinking(config.providers[model.provider], model.model)
    ) {
      enriched[alias] = model;
      continue;
    }
    enriched[alias] = { ...model, capabilities: [...declared, ALWAYS_THINKING_CAPABILITY] };
    changed = true;
  }
  return changed ? { ...config, models: enriched } : config;
}

function detectsAlwaysThinking(provider: ProviderConfig | undefined, model: string): boolean {
  if (provider === undefined) return false;
  return getProviderModelCapability(provider.type, model).always_thinking === true;
}
