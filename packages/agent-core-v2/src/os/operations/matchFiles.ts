import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { FileMatch, FileMatches, FileMatchOptions, FileMatchPath } from '#/os/interface/fileOperations';

export function compileGrepPattern<T extends Pick<FileMatchOptions, 'pattern' | 'regex' | 'case_sensitive'>>(req: T): RegExp {
  const flags = req.case_sensitive ? 'g' : 'gi';
  const body = req.regex ? req.pattern : escapeRegExp(req.pattern);
  return new RegExp(body, flags);
}

function escapeRegExp(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function matchFiles(fs: IHostFileSystem, paths: readonly FileMatchPath[], options: FileMatchOptions, timeoutMs: number, signal?: AbortSignal, maxResponseBytes = Infinity): Promise<FileMatches> {
  const re = compileGrepPattern(options);
  const files: FileMatches['files'] = [];
  let filesScanned = 0;
  let totalMatches = 0;
  let truncated = false;
  const deadline = Date.now() + timeoutMs;
  let responseBytes = 0;
  for (const file of paths) {
    if ((signal?.aborted === true || Date.now() >= deadline) && filesScanned > 0) {
      truncated = true;
      break;
    }
    if (filesScanned >= options.max_files) {
      truncated = true;
      break;
    }
    filesScanned += 1;
    let content: string;
    try {
      content = await fs.readText(file.absolute);
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    const matches: FileMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m === null) continue;
      if (matches.length >= options.max_matches_per_file) break;
      const before: string[] = [];
      for (let k = Math.max(0, i - options.context_lines); k < i; k++) {
        before.push(lines[k] ?? '');
      }
      const after: string[] = [];
      for (let k = i + 1; k < Math.min(lines.length, i + 1 + options.context_lines); k++) {
        after.push(lines[k] ?? '');
      }
      matches.push({ line: i + 1, col: m.index + 1, text: line, before, after });
      totalMatches += 1;
      if (totalMatches >= options.max_total_matches) {
        truncated = true;
        break;
      }
    }
    if (matches.length > 0) {
      responseBytes += Buffer.byteLength(JSON.stringify({ path: file.path, matches }));
      if (responseBytes > maxResponseBytes) {
        return { files: [], files_scanned: 0, truncated: false, responseTooLarge: true };
      }
      files.push({ path: file.path, matches });
    }
    if (totalMatches >= options.max_total_matches) break;
  }

  return { files, files_scanned: filesScanned, truncated };
}
