import { readTextPage } from '#/os/operations/readTextPage';
import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { isTaskOutputFilePath } from '#/agent/task/persist';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { acquireOrWhenReady, IAgentEnvironmentService, pinnedGeneration } from '#/agent/environmentBinding/agentEnvironment';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPlanService, type PlanFileTarget } from '#/features/plan/plan';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { isDaemonFileUrl } from '#/agent/media/mediaRef';
import { attachmentFileSource, environmentFileSource, withAttachmentLocation, type FileReadSource } from '#/agent/tools/fileReadSource';
import { EnvironmentWorkspaceView } from '#/environment/environmentWorkspaceView';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IConfigService } from '#/app/config/config';
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
import { literalRulePattern, matchesGlobRuleSubject, matchesPathRuleSubject } from '#/tool/rule-match';
import { renderPrompt } from '#/_base/utils/render-prompt';
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_CHARS_LIMIT,
  IReadTool,
  ReadInputSchema,
  type ReadInput,
} from './read';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { READ_SECTION, type ReadConfig } from './configSection';
import readDescriptionTemplate from './read.md?raw';

export class ReadTool implements IReadTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Read' as const;
  get description(): string {
    const limits = this.limits();
    return renderPrompt(readDescriptionTemplate, {
      DEFAULT_MAX_CHARS: limits.defaultMaxChars,
      MAX_CHARS: limits.maxChars,
    });
  }
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadInputSchema);
  constructor(
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @IAgentToolResultTruncationService private readonly resultTruncation: IAgentToolResultTruncationService,
    @IConfigService private readonly config: IConfigService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @ISessionMediaStore private readonly attachmentStore?: ISessionMediaStore,
    @IAgentPlanService private readonly planService?: IAgentPlanService,
    @IHostFileSystem private readonly hostFs?: IHostFileSystem,
    @IHostEnvironment private readonly hostEnvironment?: IHostEnvironment,
    @ISessionContext private readonly session?: ISessionContext,
    @IAgentScopeContext private readonly agent?: IAgentScopeContext,
  ) {}

  private limits(): { defaultMaxChars: number; maxChars: number } {
    const section = this.config.get<ReadConfig | undefined>(READ_SECTION);
    const maxChars = section?.maxChars ?? DEFAULT_MAX_CHARS_LIMIT;
    return {
      defaultMaxChars: Math.min(section?.defaultMaxChars ?? DEFAULT_MAX_CHARS, maxChars),
      maxChars,
    };
  }

  private workspaceConfig(view: EnvironmentWorkspaceView): WorkspaceConfig {
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  async resolveExecution(args: ReadInput): Promise<ToolExecution> {
    if (args.column_offset !== undefined && (args.line_offset ?? 1) < 0) {
      return { isError: true, output: 'column_offset is only supported for forward reads. Use a positive line_offset or the forward Next Read arguments.' };
    }
    if (isDaemonFileUrl(args.path)) return this.attachmentExecution(args);
    const planTarget = await this.planService?.resolveFile(args.path, 'read');
    if (planTarget !== undefined) return this.localArtifactExecution(args, planTarget, true);
    const artifactTarget = this.localOutputTarget(args.path);
    if (artifactTarget !== undefined) return this.localArtifactExecution(args, artifactTarget, false);
    const resolutionLease = await acquireOrWhenReady(this.environment, ['fs']);
    try {
      const inspected = resolutionLease.environment;
      const expectedGeneration = pinnedGeneration(inspected);
      const view = new EnvironmentWorkspaceView(inspected, {
        workDir: this.workspaceCtx.workDir,
        additionalDirs: [...this.workspaceCtx.additionalDirs, ...this.skillCatalog.catalog.getSkillRoots()],
      });
      const env = { _serviceBrand: undefined, ...view.host, ready: Promise.resolve() };
      const workspace = this.workspaceConfig(view);
      const path = resolvePathAccessPath(args.path, {
        env,
        workspace,
        operation: 'read',
      });
      return {
        accesses: ToolAccesses.readFile(path),
        description: `Reading ${args.path}`,
        display: { kind: 'file_io', operation: 'read', path },
        approvalRule: literalRulePattern(this.name, path),
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, path, {
            cwd: workspace.workspaceDir,
            pathClass: env.pathClass,
            homeDir: env.homeDir,
          }),
        execute: async ({ signal }) => {
          const lease = await acquireOrWhenReady(this.environment, ['fs']);
          try {
            if (expectedGeneration !== undefined && lease.environment.identity.generation !== expectedGeneration) {
              return { isError: true, output: 'Environment changed before execution. Retry the tool call.' };
            }
            const eventLog = this.resultTruncation.isWireJournalPath(path);
            const result = await this.execution(environmentFileSource(lease.environment.fs!, path), args, eventLog, signal);
            return { ...result, spillExempt: true };
          } finally {
            lease.dispose();
          }
        },
      };
    } finally {
      resolutionLease.dispose();
    }
  }

  private localOutputTarget(path: string): PlanFileTarget | undefined {
    if (this.hostFs === undefined || this.hostEnvironment === undefined || path.includes('\0')) return undefined;
    const environmentPath = this.hostEnvironment.pathClass === 'win32' ? win32Path : posixPath;
    if (!environmentPath.isAbsolute(path)) return undefined;
    const normalized = environmentPath.normalize(path);
    const taskOutput = this.session !== undefined && this.agent !== undefined && (
      isTaskOutputFilePath(normalized, environmentPath.join(this.session.sessionDir, 'agents', this.agent.agentId), environmentPath) ||
      (this.agent.agentId === 'main' && isTaskOutputFilePath(normalized, this.session.sessionDir, environmentPath))
    );
    if (!taskOutput && !this.resultTruncation.isSpillFilePath(normalized)) return undefined;
    return { fs: this.hostFs, path: normalized, environmentPath: { ...environmentPath, separator: environmentPath.sep, delimiter: environmentPath.delimiter }, pathClass: this.hostEnvironment.pathClass };
  }

  private localArtifactExecution(args: ReadInput, target: PlanFileTarget, planFile: boolean): ToolExecution {
    const { path } = target;
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Reading ${args.path}`,
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) => matchesPathRuleSubject(ruleArgs, path, {
        cwd: target.environmentPath.dirname(path), pathClass: target.pathClass,
      }),
      execute: async ({ signal }) => {
        if (planFile && (await this.planService?.resolveFile(path, 'read'))?.path !== path) {
          return { isError: true, output: 'The active plan changed before execution. Retry the tool call.' };
        }
        return { ...await this.execution(environmentFileSource(target.fs, path), args, false, signal), spillExempt: true };
      },
    };
  }

  private async attachmentExecution(args: ReadInput): Promise<ToolExecution> {
    const source = await attachmentFileSource(args.path, this.attachmentStore);
    return {
      accesses: ToolAccesses.readFile(source.localPath ?? args.path),
      description: `Reading ${args.path}`,
      display: { kind: 'file_io', operation: 'read', path: source.localPath ?? args.path },
      approvalRule: literalRulePattern(this.name, args.path),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.path),
      execute: async ({ signal }) => ({
        ...withAttachmentLocation(await this.execution(source, args, false, signal), source),
        spillExempt: true,
      }),
    };
  }

  private async execution(source: FileReadSource, args: ReadInput, eventLog: boolean, signal: AbortSignal): Promise<ExecutableToolResult> {
    const limits = this.limits();
    const capabilities = this.profile.getModelCapabilities();
    const options = {
      args,
      maxChars: Math.min(args.max_chars ?? limits.defaultMaxChars, limits.maxChars),
      maxCharsLimit: limits.maxChars,
      eventLog,
      imageSupported: capabilities.image_in,
      videoSupported: capabilities.video_in,
      mediaToolAvailable: this.toolRegistry.resolve('ReadMediaFile') !== undefined && this.toolPolicy.isToolActive('ReadMediaFile'),
    };
    return source.readTextPage === undefined ? readTextPage(source, options, signal) : source.readTextPage(options, signal);
  }

}

registerAgentToolService(IReadTool, ReadTool, {
  name: 'Read',
  domain: 'os/backends',
});
