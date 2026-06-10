import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { join } from 'pathe';

import { applyDetectedModelCapabilities } from '../../src/config/detected-capabilities';
import { getDefaultConfig, loadRuntimeConfig } from '../../src/config';
import type { KimiConfig, ModelAlias } from '../../src/config';

function configWith(model: Partial<ModelAlias> & { model: string }): KimiConfig {
  return {
    ...getDefaultConfig(),
    providers: {
      anthropic: { type: 'anthropic', apiKey: 'sk-test' },
    },
    models: {
      main: { provider: 'anthropic', maxContextSize: 1000000, ...model },
    },
  };
}

describe('applyDetectedModelCapabilities', () => {
  it('injects always_thinking for models kosong knows cannot turn thinking off', () => {
    const result = applyDetectedModelCapabilities(configWith({ model: 'claude-fable-5' }));
    expect(result.models?.['main']?.capabilities).toEqual(['always_thinking']);
  });

  it('appends to declared capabilities without duplicating', () => {
    const appended = applyDetectedModelCapabilities(
      configWith({ model: 'claude-fable-5', capabilities: ['image_in'] }),
    );
    expect(appended.models?.['main']?.capabilities).toEqual(['image_in', 'always_thinking']);

    const declared = configWith({
      model: 'claude-fable-5',
      capabilities: ['always_thinking'],
    });
    expect(applyDetectedModelCapabilities(declared)).toBe(declared);
  });

  it('leaves toggleable-thinking models untouched and returns the same config object', () => {
    const config = configWith({ model: 'claude-opus-4-6' });
    expect(applyDetectedModelCapabilities(config)).toBe(config);
    expect(config.models?.['main']?.capabilities).toBeUndefined();
  });

  it('skips models whose provider is missing instead of failing config load', () => {
    const config = configWith({ model: 'claude-fable-5' });
    config.models = { main: { ...config.models!['main']!, provider: 'gone' } };
    expect(applyDetectedModelCapabilities(config)).toBe(config);
  });
});

describe('loadRuntimeConfig capability detection', () => {
  it('exposes detected always_thinking on runtime config loaded from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-detected-caps-'));
    try {
      const file = join(dir, 'config.toml');
      writeFileSync(
        file,
        [
          'default_model = "main"',
          '',
          '[providers.anthropic]',
          'type = "anthropic"',
          'api_key = "sk-test"',
          '',
          '[models.main]',
          'provider = "anthropic"',
          'model = "claude-fable-5"',
          'max_context_size = 1000000',
        ].join('\n'),
      );
      const config = loadRuntimeConfig(file, {});
      expect(config.models?.['main']?.capabilities).toEqual(['always_thinking']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
