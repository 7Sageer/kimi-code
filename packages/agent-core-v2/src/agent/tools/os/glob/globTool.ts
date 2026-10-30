import { searchGlob } from '#/os/operations/searchGlob';

import { ensureRgPath, rgUnavailableMessage, type RgProbe } from '#/os/backends/node-local/tools/rgLocator';
import type { Environment } from '#/environment/environment';

import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { isHostFsNotFound } from '#/os/interface/hostFsErrors';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { acquireOrWhenReady, IAgentEnvironmentService, pinnedGeneration } from '#/agent/environmentBinding/agentEnvironment';
import { EnvironmentWorkspaceView } from '#/environment/environmentWorkspaceView';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IOAuthService } from '#/app/auth/auth';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import {
  resolvePathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import globDescription from './glob.md?raw';
import {
  type GlobInput,
  GlobInputSchema,
  IGlobTool,
  WINDOWS_PATH_HINT,
} from './glob';

export class GlobTool implements IGlobTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Glob' as const;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GlobInputSchema);
  constructor(
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
    @IOAuthService private readonly auth?: IOAuthService,
  ) {}

  get description(): string {
    return this.environment.inspect().host?.pathClass === 'win32'
      ? globDescription + WINDOWS_PATH_HINT
      : globDescription;
  }

  private workspaceConfig(view: EnvironmentWorkspaceView): WorkspaceConfig {
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  async resolveExecution(args: GlobInput): Promise<ToolExecution> {
    const resolutionLease = await acquireOrWhenReady(this.environment, ['fs']);
    try {
      const inspected = resolutionLease.environment;
      const expectedGeneration = pinnedGeneration(inspected);
      const view = new EnvironmentWorkspaceView(inspected, {
        workDir: this.workspaceCtx.workDir,
        additionalDirs: [
          ...this.workspaceCtx.additionalDirs,
          ...(this.skillCatalog?.catalog.getSkillRoots() ?? []),
        ],
      });
      const env = { _serviceBrand: undefined, ...view.host, ready: Promise.resolve() };
      const workspace = this.workspaceConfig(view);
      let path: string | undefined;
      if (args.path !== undefined) {
        path = resolvePathAccessPath(args.path, {
          env,
          workspace,
          operation: 'search',
          policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
        });
      }
      const searchRoots = [path ?? workspace.workspaceDir];

      const detailParts: string[] = [`pattern: ${args.pattern}`];
      if (args.path !== undefined) {
        detailParts.push(`path: ${args.path}`);
      }
      if (args.include_ignored === true) {
        detailParts.push('include_ignored: true');
      }

      return {
        accesses: ToolAccesses.searchTree(searchRoots[0]!),
        description: `Searching ${args.pattern}`,
        display: {
          kind: 'file_io',
          operation: 'glob',
          path: searchRoots[0]!,
          detail: detailParts.join(', '),
        },
        approvalRule: literalRulePattern(this.name, args.pattern),
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.pattern),
        execute: async ({ signal }) => {
          const lease = await acquireOrWhenReady(this.environment, ['fs', 'process']);
          try {
            if (expectedGeneration !== undefined && lease.environment.identity.generation !== expectedGeneration) {
              return { isError: true, output: 'Environment changed before execution. Retry the tool call.' };
            }
            return await this.execution(
              lease.environment,
              lease.environment.fs!,
              lease.environment.process!,
              env,
              workspace,
              args,
              signal,
              searchRoots,
            );
          } finally {
            lease.dispose();
          }
        },
      };
    } finally {
      resolutionLease.dispose();
    }
  }

  private async execution(
    environment: Environment,
    fs: IHostFileSystem,
    processService: IHostProcessService,
    env: IHostEnvironment,
    workspace: WorkspaceConfig,
    args: GlobInput,
    signal: AbortSignal,
    searchRoots: readonly string[],
  ): Promise<ExecutableToolResult> {
    const searchRoot = searchRoots[0] ?? workspace.workspaceDir;

    try {
      const st = await fs.stat(searchRoot);
      if (!st.isDirectory) {
        return { isError: true, output: `${searchRoot} is not a directory` };
      }
    } catch (error) {
      if (isHostFsNotFound(error)) {
        return { isError: true, output: `${searchRoot} does not exist` };
      }
      return { isError: true, output: error instanceof Error ? error.message : String(error) };
    }

    if (signal.aborted) {
      return { isError: true, output: 'Glob aborted' };
    }

    let rgPath: string;
    try {
      const resolution = await ensureRgPath(createRgProbe(processService, workspace.workspaceDir), {
        signal,
        allowCachedFallback: true,
        environment,
        resolveRegion: () => this.auth?.getRegion(),
      });
      rgPath = resolution.path;
      if (resolution.source !== 'system-path') {
        this.telemetry.track2('glob_tool_rg_fallback', {
          source: resolution.source,
          outcome: 'resolved',
        });
      }
    } catch (error) {
      if (signal.aborted) {
        return { isError: true, output: 'Glob aborted' };
      }
      this.telemetry.track2('glob_tool_rg_fallback', { outcome: 'failed' });
      return { isError: true, output: rgUnavailableMessage(error, environment) };
    }

    try {
      const request = { kind: 'glob' as const, args, rgPath, roots: searchRoots, workspaceDir: workspace.workspaceDir, pathClass: env.pathClass };
      return await (processService.search === undefined
        ? searchGlob(processService, request, signal)
        : processService.search(request, signal));
    } catch (error) {
      return { isError: true, output: formatSpawnError(error, environment) };
    }
  }

}

registerAgentToolService(IGlobTool, GlobTool, {
  name: 'Glob',
  domain: 'os/backends',
  requiredEnvironmentCapabilities: ['fs', 'process'],
});

function createRgProbe(processService: IHostProcessService, cwd: string): RgProbe {
  return {
    exec: async (args) => {
      const [command, ...rest] = args;
      if (command === undefined) return { exitCode: -1 };
      const proc = await processService.spawn(command, rest, { cwd });
      try {
        proc.stdin.end();
      } catch {
      }
      proc.stdout.resume();
      proc.stderr.resume();
      const exitCode = await proc.wait();
      try {
        void proc.dispose();
      } catch {
      }
      return { exitCode };
    },
  };
}

function formatSpawnError(error: unknown, environment: Environment): string {
  return isHostFsNotFound(error)
    ? rgUnavailableMessage(error, environment)
    : error instanceof Error
      ? error.message
      : String(error);
}

export { splitCompletePaths } from '#/os/operations/searchGlob';
