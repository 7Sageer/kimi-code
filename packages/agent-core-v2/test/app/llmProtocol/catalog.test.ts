import { describe, expect, it } from 'vitest';

import {
  getCatalogModelCapability,
  loadBuiltInCatalog,
  type Catalog,
} from '#/app/llmProtocol/catalog';

describe('getCatalogModelCapability', () => {
  const catalog: Catalog = {
    anthropic: {
      id: 'anthropic',
      models: {
        'claude-sonnet-4-5': {
          id: 'claude-sonnet-4-5',
          limit: { context: 1000000 },
          tool_call: true,
          reasoning: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      },
    },
    openai: {
      id: 'openai',
      models: {
        'gpt-4o': {
          id: 'gpt-4o',
          limit: { context: 128000 },
          tool_call: true,
          modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
        },
      },
    },
    'google-vertex-anthropic': {
      id: 'google-vertex-anthropic',
      models: {
        'claude-sonnet-4-5@20250929': {
          id: 'claude-sonnet-4-5@20250929',
          limit: { context: 200000 },
          tool_call: true,
          reasoning: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      },
    },
  };

  it('returns undefined without a catalog or for the kimi wire', () => {
    expect(getCatalogModelCapability(undefined, 'openai', 'gpt-4o')).toBeUndefined();
    expect(getCatalogModelCapability(catalog, 'kimi', 'kimi-for-coding')).toBeUndefined();
  });

  it('matches the model id under the wire-mapped first-party provider', () => {
    expect(getCatalogModelCapability(catalog, 'openai', 'gpt-4o')).toMatchObject({
      image_in: true,
      audio_in: true,
      tool_use: true,
    });
  });

  it('serves openai_responses from the openai provider entry', () => {
    expect(getCatalogModelCapability(catalog, 'openai_responses', 'gpt-4o')).toBeDefined();
  });

  it('normalizes platform-specific id shapes', () => {
    // Bedrock-style id on the anthropic wire: region + vendor prefix, revision.
    expect(
      getCatalogModelCapability(catalog, 'anthropic', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
    ).toMatchObject({ thinking: true });
    // Vertex claude ids carry an @version suffix; vertexai searches google-vertex-anthropic.
    expect(
      getCatalogModelCapability(catalog, 'vertexai', 'claude-sonnet-4-5@20250929'),
    ).toMatchObject({ thinking: true });
    // Dashed date suffixes match the undated base key.
    expect(getCatalogModelCapability(catalog, 'openai', 'gpt-4o-2024-05-13')).toBeDefined();
  });

  it('prefers an exact key over normalizing-equal entries regardless of JSON order', () => {
    const colliding: Catalog = {
      anthropic: {
        id: 'anthropic',
        models: {
          // Dated key listed first: JSON key order must not decide the winner.
          'claude-sonnet-4-5-20250929': {
            id: 'claude-sonnet-4-5-20250929',
            limit: { context: 200000 },
            tool_call: true,
            modalities: { input: ['text'], output: ['text'] },
          },
          'claude-sonnet-4-5': {
            id: 'claude-sonnet-4-5',
            limit: { context: 200000 },
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
        },
      },
    };

    // Exact base id wins over the earlier dated key; exact dated id wins over
    // the base entry; case-insensitive exact still beats the normalized scan.
    expect(getCatalogModelCapability(colliding, 'anthropic', 'claude-sonnet-4-5')).toMatchObject({
      image_in: true,
    });
    expect(
      getCatalogModelCapability(colliding, 'anthropic', 'claude-sonnet-4-5-20250929'),
    ).toMatchObject({ image_in: false });
    expect(getCatalogModelCapability(colliding, 'anthropic', 'Claude-Sonnet-4-5')).toMatchObject({
      image_in: true,
    });
  });

  it('returns undefined for models absent from the catalog', () => {
    expect(getCatalogModelCapability(catalog, 'openai', 'gpt-4.1')).toBeUndefined();
    expect(getCatalogModelCapability(catalog, 'google-genai', 'gemini-2.5-pro')).toBeUndefined();
  });
});

describe('loadBuiltInCatalog', () => {
  it('parses a pruned models.dev catalog JSON string', () => {
    const json = JSON.stringify({
      openai: {
        id: 'openai',
        models: { 'gpt-4o': { id: 'gpt-4o', limit: { context: 128000 } } },
      },
    });

    expect(loadBuiltInCatalog(json)).toMatchObject({
      openai: { models: { 'gpt-4o': { id: 'gpt-4o' } } },
    });
  });

  it('returns undefined for a missing or empty argument', () => {
    expect(loadBuiltInCatalog(undefined)).toBeUndefined();
    expect(loadBuiltInCatalog('')).toBeUndefined();
  });

  it('returns undefined for invalid JSON', () => {
    expect(loadBuiltInCatalog('{not json')).toBeUndefined();
  });
});
