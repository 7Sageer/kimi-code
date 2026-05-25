import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  PLUGIN_NAME_REGEX,
  type PluginDiagnostic,
  type PluginInterface,
  type PluginManifest,
  type PluginManifestKind,
  type PluginRecognizedFields,
} from './types';

const NATIVE_PATH = '.kimi-plugin/plugin.json';
const CODEX_PATH = '.codex-plugin/plugin.json';

export interface ParsedManifestResult {
  readonly manifest?: PluginManifest;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly recognizedFields: PluginRecognizedFields;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export async function parseManifest(pluginRoot: string): Promise<ParsedManifestResult> {
  const nativePath = path.join(pluginRoot, NATIVE_PATH);
  const codexPath = path.join(pluginRoot, CODEX_PATH);
  const nativeExists = await isFile(nativePath);
  const codexExists = await isFile(codexPath);

  if (!nativeExists && !codexExists) {
    return {
      recognizedFields: {},
      diagnostics: [
        {
          severity: 'error',
          code: 'manifest.missing',
          message: `No manifest at ${NATIVE_PATH} or ${CODEX_PATH}`,
        },
      ],
    };
  }

  // .kimi-plugin/ is authoritative — never silently falls back when invalid.
  const useNative = nativeExists;
  const manifestPath = useNative ? nativePath : codexPath;
  const manifestKind: PluginManifestKind = useNative ? 'native' : 'codex';
  const shadowedManifestPath =
    useNative && codexExists ? codexPath : undefined;

  let raw: unknown;
  try {
    const text = await readFile(manifestPath, 'utf8');
    raw = JSON.parse(text);
  } catch (error) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      recognizedFields: {},
      diagnostics: [
        {
          severity: 'error',
          code: 'manifest.invalid_json',
          message: `Failed to parse ${path.relative(pluginRoot, manifestPath)}: ${(error as Error).message}`,
        },
      ],
    };
  }

  if (!isObject(raw)) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      recognizedFields: {},
      diagnostics: [
        {
          severity: 'error',
          code: 'manifest.invalid_json',
          message: 'manifest must be a JSON object',
        },
      ],
    };
  }

  const diagnostics: PluginDiagnostic[] = [];

  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (name.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'manifest.missing_name',
      message: '"name" is required',
    });
    return { manifestKind, manifestPath, shadowedManifestPath, recognizedFields: {}, diagnostics };
  }
  if (!PLUGIN_NAME_REGEX.test(name)) {
    diagnostics.push({
      severity: 'error',
      code: 'manifest.invalid_name',
      message: `"name" must match ${PLUGIN_NAME_REGEX} (got "${name}")`,
    });
    return { manifestKind, manifestPath, shadowedManifestPath, recognizedFields: {}, diagnostics };
  }

  const skills = await resolveSkillsField(pluginRoot, raw['skills'], diagnostics);

  const recognizedFields: { hooks?: boolean; mcpServers?: boolean; apps?: boolean } = {};
  for (const field of ['hooks', 'mcpServers', 'apps'] as const) {
    if (raw[field] !== undefined) {
      recognizedFields[field] = true;
      diagnostics.push({
        severity: 'info',
        code: `manifest.unknown_field.${field}`,
        message: `"${field}" is present but Kimi does not execute it in v1`,
      });
    }
  }

  const manifest: PluginManifest = {
    name,
    version: stringField(raw, 'version'),
    description: stringField(raw, 'description'),
    homepage: stringField(raw, 'homepage'),
    license: stringField(raw, 'license'),
    author: readAuthor(raw['author']),
    skills,
    bootstrap: readBootstrap(raw['bootstrap']),
    interface: readInterface(raw['interface']),
  };

  return {
    manifest,
    manifestKind,
    manifestPath,
    shadowedManifestPath,
    recognizedFields,
    diagnostics,
  };
}

async function resolveSkillsField(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly string[]> {
  if (raw === undefined) return [];
  const entries: string[] = [];
  if (typeof raw === 'string') {
    entries.push(raw);
  } else if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    entries.push(...(raw as string[]));
  } else {
    diagnostics.push({
      severity: 'error',
      code: 'manifest.skills.invalid_type',
      message: '"skills" must be a string or string[]',
    });
    return [];
  }

  const resolved: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('./')) {
      diagnostics.push({
        severity: 'error',
        code: 'manifest.skills.path_required_dot_slash',
        message: `"skills" path must start with "./" (got "${entry}")`,
      });
      continue;
    }
    const absolute = path.resolve(pluginRoot, entry);
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      real = absolute; // missing path is allowed; we'll catch via not_a_directory below
    }
    const rootReal = await realpath(pluginRoot).catch(() => pluginRoot);
    if (!isWithin(real, rootReal)) {
      diagnostics.push({
        severity: 'error',
        code: 'manifest.skills.path_escape',
        message: `"skills" path resolves outside the plugin (${entry})`,
      });
      continue;
    }
    if (!(await isDir(real))) {
      diagnostics.push({
        severity: 'warn',
        code: 'manifest.skills.not_a_directory',
        message: `"skills" path is not a directory (${entry})`,
      });
      continue;
    }
    resolved.push(real);
  }
  return resolved;
}

function readBootstrap(raw: unknown): PluginManifest['bootstrap'] {
  if (!isObject(raw)) return undefined;
  const skill = typeof raw['skill'] === 'string' ? raw['skill'].trim() : '';
  if (skill.length === 0) return undefined;
  return { skill };
}

function readAuthor(raw: unknown): PluginManifest['author'] {
  if (typeof raw === 'string') return { name: raw };
  if (!isObject(raw)) return undefined;
  const name = stringField(raw, 'name');
  const email = stringField(raw, 'email');
  if (name === undefined && email === undefined) return undefined;
  return { name, email };
}

function readInterface(raw: unknown): PluginInterface | undefined {
  if (!isObject(raw)) return undefined;
  const out: PluginInterface = {
    displayName: stringField(raw, 'displayName'),
    shortDescription: stringField(raw, 'shortDescription'),
    longDescription: stringField(raw, 'longDescription'),
    developerName: stringField(raw, 'developerName'),
    capabilities: stringArrayField(raw, 'capabilities'),
    websiteURL: stringField(raw, 'websiteURL'),
    defaultPrompt: defaultPromptField(raw['defaultPrompt']),
  };
  // Return undefined if literally everything is absent — keeps record clean.
  const hasAny = Object.values(out).some((value) => value !== undefined);
  return hasAny ? out : undefined;
}

function defaultPromptField(raw: unknown): PluginInterface['defaultPrompt'] {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    return raw as readonly string[];
  }
  return undefined;
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stringArrayField(raw: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = raw[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined;
  return value as readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
