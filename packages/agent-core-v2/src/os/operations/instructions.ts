import { dirname, join, normalize } from 'pathe';

import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { findGitWorkTree } from './gitWorkTree';

export const AGENTS_MD_PLAIN_NAMES = ['AGENTS.md', 'agents.md'] as const;

export function dotKimiAgentsMdPath(dir: string): string {
  return join(dir, '.kimi-code', 'AGENTS.md');
}

export function agentsMdCandidatePaths(dir: string): string[] {
  return [dotKimiAgentsMdPath(dir), ...AGENTS_MD_PLAIN_NAMES.map((name) => join(dir, name))];
}

export async function findAgentsMdInDir(
  deps: { readonly fs: Pick<IHostFileSystem, 'stat' | 'readText'> },
  dir: string,
): Promise<string[]> {
  const found: string[] = [];
  const dotKimi = dotKimiAgentsMdPath(dir);
  if (await isNonEmptyFile(deps, dotKimi)) found.push(dotKimi);
  for (const fileName of AGENTS_MD_PLAIN_NAMES) {
    const candidate = join(dir, fileName);
    if (await isNonEmptyFile(deps, candidate)) {
      found.push(candidate);
      break;
    }
  }
  return found;
}

async function isNonEmptyFile(
  deps: { readonly fs: Pick<IHostFileSystem, 'stat' | 'readText'> },
  path: string,
): Promise<boolean> {
  try {
    const content = await deps.fs.readText(path, { errors: 'ignore' });
    return content.trim().length > 0;
  } catch {
    return false;
  }
}

export function dirsRootToLeaf(workDir: string, projectRoot: string): string[] {
  const dirs: string[] = [];
  let current = normalize(workDir);

  while (true) {
    dirs.push(current);
    if (current === projectRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs.toReversed();
}

export async function discoverInstructions(fs: IHostFileSystem, dirs: readonly string[], knownPaths: readonly string[]): Promise<string[]> {
  const known = new Set(knownPaths.map(normalize));
  const stats = new Map<string, Promise<HostFileStat>>();
  const contents = new Map<string, Promise<string>>();
  const probe: Pick<IHostFileSystem, 'stat' | 'readText'> = {
    stat: (path) => {
      let pending = stats.get(path);
      if (pending === undefined) {
        pending = fs.stat(path);
        stats.set(path, pending);
      }
      return pending;
    },
    readText: (path, options) => {
      const key = JSON.stringify([path, options]);
      let pending = contents.get(key);
      if (pending === undefined) {
        pending = fs.readText(path, options);
        contents.set(key, pending);
      }
      return pending;
    },
  };
  const found = new Set<string>();
  const inspected = new Set<string>();
  for (const dir of new Set(dirs)) {
    let anchor = dir;
    let exists = false;
    for (;;) {
      if ((await probe.stat(anchor).catch(() => undefined))?.isDirectory === true) {
        exists = true;
        break;
      }
      const parent = dirname(anchor);
      if (parent === anchor) break;
      anchor = parent;
    }
    if (!exists) continue;
    const projectRoot = (await findGitWorkTree(probe, anchor))?.root ?? anchor;
    for (const chainDir of dirsRootToLeaf(anchor, projectRoot)) {
      if (inspected.has(chainDir)) continue;
      inspected.add(chainDir);
      if (agentsMdCandidatePaths(chainDir).every((path) => known.has(normalize(path)))) continue;
      for (const path of await findAgentsMdInDir({ fs }, chainDir)) found.add(normalize(path));
    }
  }
  return [...found];
}
