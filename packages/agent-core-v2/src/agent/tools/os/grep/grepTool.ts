import { searchGrep } from '#/os/operations/searchGrep';

import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IOAuthService } from '#/app/auth/auth';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { isHostFsNotFound } from '#/os/interface/hostFsErrors';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { acquireOrWhenReady, IAgentEnvironmentService, pinnedGeneration } from '#/agent/environmentBinding/agentEnvironment';
import type { Environment } from '#/environment/environment';
import { EnvironmentWorkspaceView } from '#/environment/environmentWorkspaceView';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  resolvePathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  ensureRgPath,
  rgUnavailableMessage,
  type RgProbe,
} from '#/os/backends/node-local/tools/rgLocator';

import GREP_DESCRIPTION from './grep.md?raw';
import { type GrepInput, GrepInputSchema, IGrepTool } from './grep';

export class GrepTool implements IGrepTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Grep' as const;
  readonly description = GREP_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GrepInputSchema);
  constructor(
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
    @IOAuthService private readonly auth?: IOAuthService,
  ) {}

  private workspace(view: EnvironmentWorkspaceView): WorkspaceConfig {
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  async resolveExecution(args: GrepInput): Promise<ToolExecution> {
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
      const workspace = this.workspace(view);
      let path: string | undefined;
      if (args.path !== undefined) {
        path = resolvePathAccessPath(args.path, {
          env,
          workspace,
          operation: 'search',
          policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
        });
      }
      const searchPaths = [path ?? workspace.workspaceDir];
      const searchPath = args.path ?? workspace.workspaceDir;
      return {
        accesses: ToolAccesses.searchTree(searchPaths[0]!),
        description: `Searching for '${args.pattern}' in ${searchPath}`,
        display: { kind: 'file_io', operation: 'grep', path: searchPaths[0]! },
        approvalRule: literalRulePattern(this.name, args.pattern),
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.pattern),
        execute: async ({ signal }) => {
          const lease = await acquireOrWhenReady(this.environment, ['fs', 'process']);
          try {
            if (expectedGeneration !== undefined && lease.environment.identity.generation !== expectedGeneration) {
              return { isError: true, output: 'Environment changed before execution. Retry the tool call.' };
            }
            return await this.execution(lease.environment, lease.environment.process!, lease.environment.fs!, env, workspace, args, signal, searchPaths);
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
    processService: IHostProcessService,
    fs: IHostFileSystem,
    env: IHostEnvironment,
    workspace: WorkspaceConfig,
    args: GrepInput,
    signal: AbortSignal,
    searchPaths: string[],
  ): Promise<ExecutableToolResult> {
    if (signal.aborted) {
      return { isError: true, output: 'Aborted before search started' };
    }

    let rgPath: string;
    try {
      const resolution = await ensureRgPath(this.createRgProbe(processService, workspace.workspaceDir), {
        signal,
        allowCachedFallback: true,
        environment,
        resolveRegion: () => this.auth?.getRegion(),
      });
      rgPath = resolution.path;
      if (resolution.source !== 'system-path') {
        this.telemetry.track2('grep_tool_rg_fallback', {
          source: resolution.source,
          outcome: 'resolved',
        });
      }
    } catch (error) {
      if (signal.aborted) {
        return { isError: true, output: 'Grep aborted' };
      }
      this.telemetry.track2('grep_tool_rg_fallback', { outcome: 'failed' });
      return { isError: true, output: rgUnavailableMessage(error, environment) };
    }

    try {
      const request = { kind: 'grep' as const, args, rgPath, roots: searchPaths, workspaceDir: workspace.workspaceDir, pathClass: env.pathClass };
      return await (processService.search === undefined
        ? searchGrep(processService, request, signal)
        : processService.search(request, signal));
    } catch (error) {
      return { isError: true, output: formatSpawnError(error, environment) };
    }
  }
  private createRgProbe(processService: IHostProcessService, cwd: string): RgProbe {
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

}

registerAgentToolService(IGrepTool, GrepTool, {
  name: 'Grep',
  domain: 'os/backends',
  requiredEnvironmentCapabilities: ['fs', 'process'],
});

function formatSpawnError(error: unknown, environment: Environment): string {
  return isHostFsNotFound(error)
    ? rgUnavailableMessage(error, environment)
    : error instanceof Error
      ? error.message
      : String(error);
}
