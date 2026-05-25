import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseManifest } from '../../src/plugin/manifest';

async function makePlugin(
  files: Record<string, string>,
  options: { dirs?: readonly string[] } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kimi-plugin-test-'));
  for (const dir of options.dirs ?? []) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, 'utf8');
  }
  return await realpath(root);
}

describe('parseManifest', () => {
  it('reads a minimal .kimi-plugin/plugin.json', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.name).toBe('demo');
    expect(result.manifest?.version).toBe('1.0.0');
    expect(result.manifestKind).toBe('native');
    expect(result.diagnostics).toEqual([]);
  });

  it('falls back to .codex-plugin/plugin.json when native is absent', async () => {
    const root = await makePlugin({
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'demo' }),
    });
    const result = await parseManifest(root);
    expect(result.manifestKind).toBe('codex');
    expect(result.manifest?.name).toBe('demo');
  });

  it('does NOT fall back to .codex-plugin/ when .kimi-plugin/ is invalid JSON', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': '{ not json',
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'codex-version' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest).toBeUndefined();
    expect(result.manifestKind).toBe('native');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.invalid_json' }),
    );
    expect(result.shadowedManifestPath).toBe(path.join(root, '.codex-plugin/plugin.json'));
  });

  it('reports shadowed codex manifest when native is valid', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo' }),
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'demo' }),
    });
    const result = await parseManifest(root);
    expect(result.shadowedManifestPath).toBe(path.join(root, '.codex-plugin/plugin.json'));
  });

  it('rejects names that violate the regex', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'Bad Name!' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.invalid_name' }),
    );
  });

  it('returns manifest.missing when neither file exists', async () => {
    const root = await makePlugin({});
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.missing' }),
    );
  });

  it('resolves a single skills path', async () => {
    const root = await makePlugin(
      { '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo', skills: './skills/' }) },
      { dirs: ['skills'] },
    );
    const result = await parseManifest(root);
    expect(result.manifest?.skills).toEqual([path.join(root, 'skills')]);
  });

  it('resolves an array of skills paths', async () => {
    const root = await makePlugin(
      {
        '.kimi-plugin/plugin.json': JSON.stringify({
          name: 'demo',
          skills: ['./a/', './b/'],
        }),
      },
      { dirs: ['a', 'b'] },
    );
    const result = await parseManifest(root);
    expect(result.manifest?.skills).toEqual([path.join(root, 'a'), path.join(root, 'b')]);
  });

  it('rejects a skills path not prefixed with ./', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo', skills: 'skills/' }),
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.skills.path_required_dot_slash' }),
    );
    expect(result.manifest?.skills).toEqual([]);
  });

  it('rejects a skills path that escapes plugin_root', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo', skills: './../escape' }),
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.skills.path_escape' }),
    );
  });

  it('rejects a skills path that escapes via a symlink', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo', skills: './sym' }),
    });
    const outside = await mkdtemp(path.join(tmpdir(), 'kimi-plugin-outside-'));
    await symlink(outside, path.join(root, 'sym'));
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.skills.path_escape' }),
    );
  });

  it('warns when skills resolves to a non-directory', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo', skills: './notes.md' }),
      'notes.md': 'hi',
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'manifest.skills.not_a_directory',
        severity: 'warn',
      }),
    );
  });

  it('records recognized-but-ignored fields from .codex-plugin/', async () => {
    const root = await makePlugin({
      '.codex-plugin/plugin.json': JSON.stringify({
        name: 'demo',
        hooks: { 'session-start': './hooks/session-start' },
        mcpServers: './mcp.json',
        apps: './apps',
      }),
    });
    const result = await parseManifest(root);
    expect(result.recognizedFields).toEqual({ hooks: true, mcpServers: true, apps: true });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.unknown_field.hooks', severity: 'info' }),
    );
  });

  it('captures interface.displayName and shortDescription', async () => {
    const root = await makePlugin({
      '.codex-plugin/plugin.json': JSON.stringify({
        name: 'demo',
        interface: { displayName: 'Demo', shortDescription: 'A demo.' },
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.interface?.displayName).toBe('Demo');
    expect(result.manifest?.interface?.shortDescription).toBe('A demo.');
  });
});
