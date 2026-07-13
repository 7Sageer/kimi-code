import type { ModelCapability } from './capability';
import type { ProviderType } from './providers/providers';

/**
 * models.dev-style catalog: a public map of provider/model metadata. Callers
 * consume a snapshot of this shape to populate provider + model configuration
 * without hand-writing context windows or capabilities.
 */
export interface CatalogModelEntry {
  readonly id?: string;
  readonly name?: string;
  readonly family?: string;
  readonly limit?: { readonly context?: number; readonly output?: number };
  readonly tool_call?: boolean;
  readonly reasoning?: boolean;
  readonly select_tools?: boolean;
  readonly interleaved?: boolean | { readonly field?: string };
  readonly modalities?: {
    readonly input?: readonly string[];
    readonly output?: readonly string[];
  };
}

export interface CatalogProviderEntry {
  readonly id?: string;
  readonly name?: string;
  /** Base URL for the provider; may be empty (some SDKs hardcode it). */
  readonly api?: string;
  /** Env var names carrying credentials — surfaced as a hint by callers. */
  readonly env?: readonly string[];
  /** models.dev SDK package id; used to infer the wire type when `type` is absent. */
  readonly npm?: string;
  /** Explicit wire type extension; inferred from `npm`/`id` when absent. */
  readonly type?: string;
  readonly models?: Record<string, CatalogModelEntry>;
}

/** Top-level catalog: `{ [providerId]: ProviderEntry }` (e.g. models.dev/api.json). */
export type Catalog = Record<string, CatalogProviderEntry>;

/** A normalized catalog model: identity plus its {@link ModelCapability}. */
export interface CatalogModel {
  readonly id: string;
  readonly name?: string;
  readonly maxOutputSize?: number;
  readonly reasoningKey?: string;
  readonly capability: ModelCapability;
}

const KNOWN_WIRE_TYPES = [
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
] as const satisfies readonly ProviderType[];

function isWireType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (KNOWN_WIRE_TYPES as readonly string[]).includes(value);
}

function hasEmbeddingMarker(value: string | undefined): boolean {
  if (value === undefined) return false;
  const lower = value.toLowerCase();
  return lower.includes('embedding') || /(?:^|[-_/])embed(?:$|[-_/])/.test(lower);
}

function isUsableChatModel(model: CatalogModelEntry): boolean {
  const outputModalities = model.modalities?.output;
  if (outputModalities !== undefined && !outputModalities.includes('text')) return false;
  return (
    !hasEmbeddingMarker(model.family) &&
    !hasEmbeddingMarker(model.id) &&
    !hasEmbeddingMarker(model.name)
  );
}

/**
 * Resolves a catalog provider entry to a supported wire type. Honors an
 * explicit `type`, otherwise infers from `npm`/`id`. Unknown providers return
 * `undefined` so callers can omit them instead of writing an invalid config.
 */
export function inferWireType(entry: CatalogProviderEntry): ProviderType | undefined {
  if (isWireType(entry.type)) return entry.type;
  const npm = (entry.npm ?? '').toLowerCase();
  const id = (entry.id ?? '').toLowerCase();
  if (npm.includes('anthropic') || id.includes('anthropic') || id.includes('claude')) {
    return 'anthropic';
  }
  if (id.includes('vertex')) return 'vertexai';
  if (npm.includes('google') || id.includes('google') || id.includes('gemini')) {
    return 'google-genai';
  }
  if (npm.includes('openai') || id.includes('openai')) return 'openai';
  return undefined;
}

/**
 * Resolves the base URL to store for a catalog provider, adapting the catalog's
 * `api` to the wire's SDK convention.
 *
 * models.dev `api` URLs are written for the SDK named in `npm` (e.g.
 * `@ai-sdk/anthropic`), whose base already includes the `/v1` version segment.
 * We route the `anthropic` wire through the official `@anthropic-ai/sdk`, which
 * appends `/v1/messages` itself — so a catalog `api` ending in `/v1` would POST
 * to `/v1/v1/messages` (404). Strip the trailing `/v1` for anthropic. OpenAI
 * family SDKs append `/chat/completions` to a `/v1` base, so those pass through.
 */
export function catalogBaseUrl(
  entry: CatalogProviderEntry,
  wire: ProviderType,
): string | undefined {
  const api = entry.api;
  if (typeof api !== 'string' || api.length === 0) return undefined;
  if (wire === 'anthropic') return api.replace(/\/v1\/?$/, '');
  return api;
}

/** Normalizes one catalog model entry into a {@link CatalogModel}; skips invalid entries. */
export function catalogModelToCapability(model: CatalogModelEntry): CatalogModel | undefined {
  if (typeof model.id !== 'string' || model.id.length === 0) return undefined;
  const context = model.limit?.context;
  if (typeof context !== 'number' || !Number.isInteger(context) || context <= 0) return undefined;
  if (!isUsableChatModel(model)) return undefined;
  const inputs = model.modalities?.input ?? [];
  const output = model.limit?.output;
  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name.length > 0 ? model.name : undefined,
    maxOutputSize: typeof output === 'number' && output > 0 ? output : undefined,
    reasoningKey: catalogReasoningKey(model.interleaved),
    capability: {
      image_in: inputs.includes('image'),
      video_in: inputs.includes('video'),
      audio_in: inputs.includes('audio'),
      thinking: Boolean(model.reasoning),
      tool_use: model.tool_call ?? true,
      max_context_tokens: context,
      select_tools: model.select_tools === true,
    },
  };
}

function catalogReasoningKey(interleaved: CatalogModelEntry['interleaved']): string | undefined {
  // models.dev allows `interleaved: true` as "general support" — read it as
  // the default `reasoning_content` field so providers without an explicit
  // field name (e.g. some openai-compatible gateways) still round-trip.
  if (interleaved === true) return 'reasoning_content';
  if (typeof interleaved !== 'object' || interleaved === null) return undefined;
  const field = interleaved.field?.trim();
  return field !== undefined && field.length > 0 ? field : undefined;
}

/** Extracts the valid, normalized models from a catalog provider entry. */
export function catalogProviderModels(entry: CatalogProviderEntry): CatalogModel[] {
  const models = entry.models ?? {};
  return Object.values(models)
    .map((model) => catalogModelToCapability(model))
    .filter((model): model is CatalogModel => model !== undefined);
}

/**
 * models.dev provider ids searched for each wire type when the catalog serves
 * as a capability fallback. Only first-party providers are mapped: a relay or
 * gateway transparently proxies the upstream model, so the first-party entry
 * carries the same boolean capabilities. The `kimi` wire is intentionally
 * absent — its capabilities come from config declarations.
 */
const CATALOG_FALLBACK_PROVIDER_IDS: Partial<Record<ProviderType, readonly string[]>> = {
  anthropic: ['anthropic'],
  openai: ['openai'],
  openai_responses: ['openai'],
  'google-genai': ['google'],
  vertexai: ['google-vertex', 'google-vertex-anthropic'],
};

/**
 * Normalizes a catalog model key or configured model id so platform-specific
 * id shapes still compare equal: Bedrock region (`us.`) / vendor (`anthropic.`)
 * prefixes, Vertex `@version` suffixes, Bedrock `-v1:0` revisions, and trailing
 * date stamps (`-20251001`, `-2024-05-13`).
 */
function normalizeCatalogModelKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/^(?:us|eu|apac|global)\./, '')
    .replace(/^(?:anthropic|ai21|amazon|cohere|deepseek|meta|mistral|writer)\./, '')
    .replace(/@.*$/, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

/**
 * Looks up a model's {@link ModelCapability} in a models.dev catalog snapshot.
 * The lookup keys on wire type, not the user's provider id: a provider pointed
 * at a relay base URL still proxies the first-party model, whose catalogued
 * capabilities apply. An exact catalog key match takes precedence over the
 * normalized comparison: several keys normalize to the same string (a base id
 * and its dated snapshots), and the exact entry must not lose to JSON key
 * order. Returns `undefined` on any miss (no catalog, unmapped wire, absent
 * provider entry, unmatched or non-chat model) so callers can fall back to
 * the built-in capability table.
 */
export function getCatalogModelCapability(
  catalog: Catalog | undefined,
  wire: ProviderType,
  modelName: string,
): ModelCapability | undefined {
  if (catalog === undefined) return undefined;
  const providerIds = CATALOG_FALLBACK_PROVIDER_IDS[wire];
  if (providerIds === undefined) return undefined;
  const target = normalizeCatalogModelKey(modelName);
  for (const providerId of providerIds) {
    const models = catalog[providerId]?.models;
    if (models === undefined) continue;
    const exact = models[modelName] ?? models[modelName.toLowerCase()];
    if (exact !== undefined) {
      const model = catalogModelToCapability(exact);
      if (model !== undefined) return model.capability;
    }
    for (const [key, entry] of Object.entries(models)) {
      if (normalizeCatalogModelKey(key) !== target) continue;
      const model = catalogModelToCapability(entry);
      if (model !== undefined) return model.capability;
    }
  }
  return undefined;
}

/**
 * Parses an optional pruned models.dev catalog string — typically the
 * `__KIMI_CODE_BUILT_IN_CATALOG__` constant injected by tsdown at build
 * time. Returns `undefined` when the argument is missing or invalid.
 */
export function loadBuiltInCatalog(json: string | undefined): Catalog | undefined {
  if (typeof json !== 'string' || json.length === 0) return undefined;
  try {
    return JSON.parse(json) as Catalog;
  } catch {
    return undefined;
  }
}
