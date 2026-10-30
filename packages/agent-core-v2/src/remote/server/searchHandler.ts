import { PROCESS_MAX_ACTIVE_SEARCHES, PROCESS_SEARCH_MAX_ROOTS } from '#/remote/protocol/methods';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { SearchRequest, SearchResult } from '#/os/interface/searchOperations';
import { searchGlob } from '#/os/operations/searchGlob';
import { searchGrep } from '#/os/operations/searchGrep';
import { RpcError, RpcErrorCode } from '#/remote/protocol/errors';
import { optionalBoolean, optionalInteger, requireAbsolutePath, requireParams, requireString } from './fsHandler';

export class SearchHandler {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<SearchResult> }>();

  constructor(private readonly process: IHostProcessService) {}

  async search(rawParams: unknown): Promise<SearchResult> {
    const params = requireParams(rawParams);
    const searchId = requireString(params, 'searchId');
    const kind = requireString(params, 'kind');
    if (kind !== 'glob' && kind !== 'grep') throw new RpcError(RpcErrorCode.InvalidParams, 'invalid search kind');
    const rawArgs = requireParams(params['args']);
    const roots = params['roots'];
    if (!Array.isArray(roots) || roots.length === 0 || roots.length > PROCESS_SEARCH_MAX_ROOTS) throw new RpcError(RpcErrorCode.InvalidParams, 'invalid search roots');
    const pattern = rawArgs['pattern'];
    if (typeof pattern !== 'string') throw new RpcError(RpcErrorCode.InvalidParams, 'pattern must be a string');
    const outputMode = rawArgs['output_mode'];
    if (outputMode !== undefined && outputMode !== 'content' && outputMode !== 'files_with_matches' && outputMode !== 'count_matches') throw new RpcError(RpcErrorCode.InvalidParams, 'invalid search output mode');
    const pathClass = params['pathClass'];
    if (pathClass !== 'posix' && pathClass !== 'win32') throw new RpcError(RpcErrorCode.InvalidParams, 'invalid search path class');
    const optionalString = (key: string): string | undefined => {
      const value = rawArgs[key];
      if (value !== undefined && typeof value !== 'string') throw new RpcError(RpcErrorCode.InvalidParams, `${key} must be a string`);
      return value;
    };
    const request: SearchRequest = {
      kind,
      roots: roots.map((root: unknown) => requireAbsolutePath({ root }, 'root')),
      workspaceDir: requireAbsolutePath(params, 'workspaceDir'),
      rgPath: requireString(params, 'rgPath'),
      pathClass,
      args: {
        pattern,
        glob: optionalString('glob'),
        type: optionalString('type'),
        output_mode: outputMode,
        offset: optionalInteger(rawArgs, 'offset', 0, Number.MAX_SAFE_INTEGER),
        head_limit: optionalInteger(rawArgs, 'head_limit', 0, Number.MAX_SAFE_INTEGER),
        include_ignored: optionalBoolean(rawArgs, 'include_ignored'),
        multiline: optionalBoolean(rawArgs, 'multiline'),
        '-i': optionalBoolean(rawArgs, '-i'),
        '-n': optionalBoolean(rawArgs, '-n'),
        '-A': optionalInteger(rawArgs, '-A', 0, Number.MAX_SAFE_INTEGER),
        '-B': optionalInteger(rawArgs, '-B', 0, Number.MAX_SAFE_INTEGER),
        '-C': optionalInteger(rawArgs, '-C', 0, Number.MAX_SAFE_INTEGER),
      },
    };
    if (this.active.has(searchId) || this.active.size >= PROCESS_MAX_ACTIVE_SEARCHES) throw new RpcError(RpcErrorCode.InvalidRequest, 'search ID is active or too many active searches');
    const controller = new AbortController();
    const done = kind === 'glob' ? searchGlob(this.process, request, controller.signal) : searchGrep(this.process, request, controller.signal);
    this.active.set(searchId, { controller, done });
    try {
      return await done;
    } finally {
      this.active.delete(searchId);
    }
  }

  cancel(rawParams: unknown): void {
    const params = requireParams(rawParams);
    this.active.get(requireString(params, 'searchId'))?.controller.abort();
  }

  async dispose(): Promise<void> {
    const pending = [...this.active.values()];
    for (const search of pending) search.controller.abort();
    await Promise.allSettled(pending.map((search) => search.done));
  }
}
