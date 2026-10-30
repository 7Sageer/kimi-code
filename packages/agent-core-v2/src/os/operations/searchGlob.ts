import { normalize, resolve } from 'pathe';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { SearchRequest, SearchResult, GlobSearchInput as GlobInput } from '#/os/interface/searchOperations';
import { isSensitiveFile, SENSITIVE_DOT_VARIANT_SUFFIXES, isWithinDirectory } from '#/_base/fs/pathFilters';
import { DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS } from '#/_base/text/outputLimits';
import { DEFAULT_TIMEOUT_MS, MAX_OUTPUT_BYTES, runRgOnce, shouldRetryRipgrepEagain } from './runRg';

type PathClass = 'posix' | 'win32';
const DEFAULT_HEAD_LIMIT = 100;

const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'] as const;

const SENSITIVE_KEY_BASENAMES = ['id_rsa', 'id_ed25519', 'id_ecdsa'] as const;
const SENSITIVE_GLOBS_TO_EXCLUDE: readonly string[] = [
  '**/.env',
  ...SENSITIVE_KEY_BASENAMES.flatMap((name) => [
    `**/${name}`,
    `**/${name}[-_]*`,
    ...SENSITIVE_DOT_VARIANT_SUFFIXES.map((suffix) => `**/${name}${suffix}`),
  ]),
  '**/.aws/credentials',
  '**/.aws/credentials/**',
  '**/.gcp/credentials',
  '**/.gcp/credentials/**',
];

export async function searchGlob(processService: IHostProcessService, request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
  const { args, rgPath, roots: searchPaths, workspaceDir, pathClass } = request;
  const searchRoot = searchPaths[0] ?? workspaceDir;
  let run;
  run = await runRgOnce(processService, buildRgArgs(rgPath, args), signal, { cwd: searchRoot });
  if (run.kind === 'aborted') {
    return { isError: true, output: 'Glob aborted' };
  }

  if (shouldRetryRipgrepEagain(run)) {
    run = await runRgOnce(processService, buildRgArgs(rgPath, args, true), signal, { cwd: searchRoot });
    if (run.kind === 'aborted') {
      return { isError: true, output: 'Glob aborted' };
    }
  }

  const { exitCode, stdoutText, stderrText, bufferTruncated, timedOut } = run;

  let traversalWarning: string | undefined;
  if (exitCode !== 0 && exitCode !== 1 && !timedOut && !run.outputLimitReached) {
    const rawPathsBeforeError = splitCompletePaths(stdoutText, true);
    if (rawPathsBeforeError.length === 0) {
      return { isError: true, output: formatGlobError(searchRoot, stderrText) };
    }
    traversalWarning = formatGlobWarning(stderrText);
  }
  if (signal.aborted) {
    return { isError: true, output: 'Glob aborted' };
  }

  const rawPaths = splitCompletePaths(stdoutText, bufferTruncated || timedOut).map((p) =>
    resolve(searchRoot, p),
  );

  const kept: string[] = [];
  let filteredSensitive = 0;
  for (const p of rawPaths) {
    if (isSensitiveFile(p)) {
      filteredSensitive++;
    } else {
      kept.push(p);
    }
  }

  const offset = args.offset ?? 0;
  const headLimit = args.head_limit ?? DEFAULT_HEAD_LIMIT;
  const limited = headLimit === 0 ? kept.slice(offset) : kept.slice(offset, offset + headLimit);
  const partial = bufferTruncated || timedOut || traversalWarning !== undefined;

  const shouldRelativize = isWithinDirectory(searchRoot, workspaceDir, pathClass);
  const candidates = limited.map((p) =>
    shouldRelativize ? relativizeIfUnder(p, searchRoot, pathClass) : p,
  );

  const warnings: string[] = [];
  if (timedOut) {
    warnings.push(
      `Glob timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s; partial results returned.`,
    );
  }
  if (bufferTruncated) {
    warnings.push(
      `[stdout truncated at ${String(MAX_OUTPUT_BYTES)} bytes; results may be incomplete — use a more specific pattern]`,
    );
  }
  if (traversalWarning !== undefined) {
    warnings.push(traversalWarning);
  }
  const pageNotices = (count: number, characterLimited: boolean) => {
    const lines = [...warnings];
    const footer: string[] = [];
    const truncated = characterLimited || offset + count < kept.length;
    if (count === 0) {
      if (kept.length > 0) {
        const resultSet = partial ? 'collected partial result set' : 'current result set';
        lines.push(
          `No more matches at offset=${String(offset)} in the ${resultSet} (${String(kept.length)} matches).`,
        );
      } else if (partial) {
        lines.push('No matches collected; search incomplete.');
      } else if (filteredSensitive > 0) {
        lines.push(
          `No non-sensitive matches found (${String(filteredSensitive)} sensitive file(s) filtered).`,
        );
      } else {
        lines.push('No matches found');
      }
    } else if (truncated || offset > 0 || partial) {
      const total = partial
        ? `${String(kept.length)} collected matches (partial result set)`
        : String(kept.length);
      lines.push(`Showing matches ${String(offset + 1)}–${String(offset + count)} of ${total}.`);
    }
    if (characterLimited) lines.push('Character limit reached; only complete paths are returned.');
    if (truncated) {
      lines.push(
        `Continue with the same search arguments and offset=${String(offset + count)}.`,
      );
      if (!characterLimited) lines.push('To remove the match-count limit, omit offset and use head_limit=0.');
    }
    if (filteredSensitive > 0 && (kept.length > 0 || partial)) {
      footer.push(`Filtered ${String(filteredSensitive)} sensitive file(s).`);
    }
    if (!truncated && !partial && offset === 0 && headLimit > 0 && count === headLimit) {
      footer.push(`Found ${String(count)} matches`);
    }
    return { lines, footer };
  };
  const noticeChars = Math.max(...[false, true].map((characterLimited) => {
    const { lines, footer } = pageNotices(candidates.length, characterLimited);
    return [...lines, ...footer].join('\n').length + 2;
  }));
  let remaining = DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS - noticeChars;
  const displayLines: string[] = [];
  for (const path of candidates) {
    if (path.length + 1 > remaining) break;
    displayLines.push(path);
    remaining -= path.length + 1;
  }
  if (candidates.length > 0 && displayLines.length === 0) {
    return {
      isError: true,
      output: 'Glob cannot fit a complete path and its diagnostics within the output limit. Narrow the search path or pattern.',
    };
  }
  const notices = pageNotices(displayLines.length, displayLines.length < candidates.length);
  return { output: [...notices.lines, ...displayLines, ...notices.footer].join('\n') };

}

function buildRgArgs(rgPath: string, args: GlobInput, singleThreaded = false): string[] {
  const cmd: string[] = [rgPath];
  if (singleThreaded) cmd.push('-j', '1');
  cmd.push('--files', '--hidden', '--sortr=modified');
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    cmd.push('--glob', `!${dir}`);
  }
  cmd.push('--glob', args.pattern);
  for (const glob of SENSITIVE_GLOBS_TO_EXCLUDE) {
    cmd.push('--glob', `!${glob}`);
  }
  if (args.include_ignored) cmd.push('--no-ignore');
  cmd.push('.');
  return cmd;
}

function formatGlobError(searchRoot: string, stderr: string): string {
  const trimmed = stderr.trim();
  if (/no such file or directory/i.test(trimmed)) {
    return `${searchRoot} does not exist`;
  }
  return trimmed.length > 0 ? `Glob failed: ${trimmed}` : 'Glob failed';
}

function formatGlobWarning(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > 0
    ? `Glob completed with warnings; some directories could not be read: ${trimmed}`
    : 'Glob completed with warnings; some directories could not be read.';
}

export function splitCompletePaths(stdoutText: string, truncatedOutput: boolean): string[] {
  let text = stdoutText;
  if (truncatedOutput && !text.endsWith('\n')) {
    const lastNewline = text.lastIndexOf('\n');
    text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
  }
  return text.split('\n').filter((p) => p.length > 0);
}

function relativizeIfUnder(candidate: string, base: string, pathClass: PathClass): string {
  const normCandidate = normalize(candidate);
  const normBase = normalize(base);
  const comparableCandidate = pathClass === 'win32' ? normCandidate.toLowerCase() : normCandidate;
  const comparableBase = pathClass === 'win32' ? normBase.toLowerCase() : normBase;
  if (comparableCandidate === comparableBase) return '.';
  const prefix = comparableBase.endsWith('/') ? comparableBase : comparableBase + '/';
  if (comparableCandidate.startsWith(prefix)) {
    return normCandidate.slice(prefix.length);
  }
  return normCandidate;
}
