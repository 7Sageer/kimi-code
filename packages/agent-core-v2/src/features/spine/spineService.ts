import { join } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import {
  COMPACTION_SUMMARY_PREFIX,
} from '#/agent/contextMemory/compactionHandoff';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { activateReminderWhenReady } from '#/features/reminder/internal/reminderActivation';
import type { ContextInjectionContext } from '#/features/reminder/types';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { SPINE_FLAG_ID } from './flag';
import { SPINE_VIEW } from './instructions';
import { IAgentSpineService, SPINE_TOOL_OPEN, type SpineTransitionResult } from './spine';
import {
  buildArchiveContent,
  buildEpochArchiveContent,
  spineArchivePath,
  writeNodeArchive,
  type SpineEpochArchiveInput,
} from './spineArchive';
import { SpineCompactionStrategy } from './spineCompactionStrategy';
import { deriveSpineState } from './spineDerive';
import { foldSpine, type SpineFoldStatus } from './spineFold';
import type { SpineNode, SpineState } from './spineState';
import {
  epochRootIds,
  isRootEpoch,
  parentNodeId,
  renderTree,
  spineNodeViewFromState,
  type SpineTreeViewInput,
} from './spineTree';

export const SPINE_VIEW_REMINDER_VARIANT = 'spine_view';

const REJECT_DISABLED: SpineTransitionResult = {
  accepted: false,
  reason: 'Spine is disabled. Enable the spine experimental flag to use it.',
};

const REJECT_CONFLICT: SpineTransitionResult = {
  accepted: false,
  reason:
    'A single assistant response may include at most one Spine transition (open, close, or next).',
};

const REJECT_ROOT_EPOCH: SpineTransitionResult = {
  accepted: false,
  reason:
    'Root-epoch nodes cannot be closed. Use open to start a child node under the current scope.',
};

const ARCHIVE_FAILURE_NOTE =
  '[spine: the trajectory archive for this node could not be written; its detailed history was not persisted.]';

export class AgentSpineService extends Disposable implements IAgentSpineService {
  declare readonly _serviceBrand: undefined;

  private transitionThisStep = false;
  private cachedMessages: readonly ContextMessage[] | undefined;
  private cachedState: SpineState | undefined;
  private cachedFoldMessages: readonly ContextMessage[] | undefined;
  private cachedFoldState: SpineState | undefined;
  private readonly archivedIds = new Set<string>();
  private readonly failedArchiveIds = new Set<string>();

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @ISessionTokenCountingService private readonly tokenCounting: ISessionTokenCountingService,
    @IEventBus eventBus: IEventBus,
    @IEventDispatcher dispatcher: IEventDispatcher,
    @IAgentLifecycleService agentLifecycle: IAgentLifecycleService,
    @IAgentLoopService loop: IAgentLoopService,
    @IAgentContextProjectorService projector: IAgentContextProjectorService,
    @IAgentFullCompactionService private readonly fullCompaction: IAgentFullCompactionService,
  ) {
    super();
    if (!this.enabled || this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    this._register(projector.registerFold('spine', (messages) => this.fold(messages)));
    this._register(
      fullCompaction.registerStrategy(
        'spine',
        new SpineCompactionStrategy(this.context, this, this.tokenCounting, this.scopeContext),
      ),
    );
    this._register(
      activateReminderWhenReady(agentLifecycle, this.scopeContext, (reminder) =>
        reminder.register(SPINE_VIEW_REMINDER_VARIANT, (ctx) => this.spineViewReminder(ctx)),
      ),
    );
    this._register(
      loop.hooks.onWillBeginStep.register('spine', async (_ctx, next) => {
        this.transitionThisStep = false;
        await next();
      }),
    );
    this._register(
      loop.hooks.onDidFinishStep.register('spine', async (_ctx, next) => {
        this.transitionThisStep = false;
        await this.archiveNewlyClosed();
        await next();
      }),
    );
    this._register(
      dispatcher.hooks.onDidRestore.register('spine', async (_ctx, next) => {
        this.cachedMessages = undefined;
        this.cachedState = undefined;
        this.clearArchiveLedgers();
        await next();
      }),
    );
    this._register(
      eventBus.subscribe(ContextSpliced, (event) => {
        if (event.deleteCount === 0) return;
        this.clearArchiveLedgers();
      }),
    );
  }

  get enabled(): boolean {
    return this.flags.enabled(SPINE_FLAG_ID);
  }

  acceptOpen(summary: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    if (summary.trim().length === 0) return reject('open summary must not be empty.');
    this.transitionThisStep = true;
    return { accepted: true };
  }

  acceptClose(memory: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    if (memory.trim().length === 0) return reject('close memory must not be empty.');
    if (isRootEpoch(this.cursorId())) return REJECT_ROOT_EPOCH;
    this.transitionThisStep = true;
    return { accepted: true };
  }

  acceptNext(summary: string, memory: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    if (summary.trim().length === 0) return reject('next summary must not be empty.');
    if (memory.trim().length === 0) return reject('next memory must not be empty.');
    if (isRootEpoch(this.cursorId())) return REJECT_ROOT_EPOCH;
    this.transitionThisStep = true;
    return { accepted: true };
  }

  renderTree(): string {
    const state = this.state();
    return renderTree({
      cursorId: this.cursorId(),
      rootIds: epochRootIds(state),
      resolve: (id) => spineNodeViewFromState(state, id, this.treeViewInput()),
    });
  }

  fold(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (!this.enabled) return messages;
    const state = this.patchFailedArchiveNotes(this.foldStateFor(messages));
    const epochSummaryMessage =
      state.epochMemoryAt === undefined ? undefined : messages[state.epochMemoryAt];
    return foldSpine(messages, {
      state,
      status: this.buildStatus(state),
      epochSummaryMessage,
      maxContextTokens: this.effectiveMaxContextTokens(),
    });
  }

  currentState(): SpineState {
    return this.state();
  }

  async archiveEpochRoot(input: SpineEpochArchiveInput): Promise<string | undefined> {
    if (!this.enabled) return undefined;
    const path = this.archivePath(String(input.epoch));
    const content = buildEpochArchiveContent(input);
    try {
      await writeNodeArchive(this.hostFs, path, content);
      this.archivedIds.add(String(input.epoch));
      return path;
    } catch (error) {
      onUnexpectedError(error);
      this.failedArchiveIds.add(String(input.epoch));
      return undefined;
    }
  }

  private spineViewReminder(ctx: ContextInjectionContext): string | undefined {
    if (!this.enabled) return undefined;
    if (!this.toolPolicy.isToolActive(SPINE_TOOL_OPEN)) return undefined;
    if (ctx.lastInjectedAt !== null && this.injectionVisible(ctx.lastInjectedAt)) return undefined;
    return SPINE_VIEW;
  }

  private injectionVisible(position: number): boolean {
    const state = this.derivedState();
    if (position < state.epochStartAt) return false;
    for (const node of Object.values(state.nodes)) {
      if (node.closedAt === undefined || node.openedAt < 0) continue;
      if (node.openedAt <= position && position <= node.closedAt) return false;
    }
    return true;
  }

  private buildStatus(
    state: SpineState,
  ): Pick<SpineFoldStatus, 'cursorId' | 'summary' | 'parentId' | 'parentSummary'> {
    const cursorId = topOf(state);
    const summary = state.nodes[cursorId]?.summary ?? '';
    const parentId = parentNodeId(cursorId);
    const parentSummary = parentId === null ? null : (state.nodes[parentId]?.summary ?? null);
    return { cursorId, summary, parentId, parentSummary };
  }

  private guard(): SpineTransitionResult | null {
    if (!this.enabled) return REJECT_DISABLED;
    if (this.transitionThisStep) return REJECT_CONFLICT;
    return null;
  }

  private state(): SpineState {
    return this.patchFailedArchiveNotes(this.derivedState());
  }

  private patchFailedArchiveNotes(derived: SpineState): SpineState {
    if (this.failedArchiveIds.size === 0) return derived;
    let nodes: Record<string, SpineNode> | undefined;
    for (const id of this.failedArchiveIds) {
      const node = derived.nodes[id];
      if (node?.memory === undefined) continue;
      nodes ??= { ...derived.nodes };
      nodes[id] = { ...node, memory: `${node.memory}\n\n${ARCHIVE_FAILURE_NOTE}` };
    }
    return nodes === undefined ? derived : { ...derived, nodes };
  }

  private derivedState(): SpineState {
    const messages = this.context.get();
    if (this.cachedState !== undefined && this.cachedMessages === messages) {
      return this.cachedState;
    }
    const state = deriveSpineState(messages);
    this.cachedMessages = messages;
    this.cachedState = state;
    return state;
  }

  private foldStateFor(messages: readonly ContextMessage[]): SpineState {
    if (this.cachedFoldState !== undefined && this.cachedFoldMessages === messages) {
      return this.cachedFoldState;
    }
    const state = deriveSpineState(messages);
    this.cachedFoldMessages = messages;
    this.cachedFoldState = state;
    return state;
  }

  private cursorId(): string {
    return topOf(this.derivedState());
  }

  private effectiveMaxContextTokens(): number | undefined {
    const max = this.fullCompaction.getEffectiveMaxContextTokens();
    return max > 0 ? max : undefined;
  }

  private treeViewInput(): SpineTreeViewInput {
    const stored = this.context.get();
    return {
      measure: (node) => {
        if (node.openedAt < 0 || node.openedAt >= stored.length) return undefined;
        const end = Math.min((node.closedAt ?? stored.length - 1) + 1, stored.length);
        return estimateTokensForMessages(stored.slice(node.openedAt, end));
      },
      resolveArchivePath: (id, epoch, closed) => this.nodeArchivePath(id, epoch, closed),
    };
  }

  private nodeArchivePath(id: string, epoch: boolean, closed: boolean): string | undefined {
    if (this.failedArchiveIds.has(id)) return undefined;
    if (epoch) return Number(id) > 1 ? this.archivePath(id) : undefined;
    return closed ? this.archivePath(id) : undefined;
  }

  private async archiveNewlyClosed(): Promise<void> {
    if (!this.enabled) return;
    const state = this.derivedState();
    const messages = this.context.get();
    for (const node of Object.values(state.nodes)) {
      if (node.closedAt === undefined || node.openedAt < 0) continue;
      if (this.archivedIds.has(node.id) || this.failedArchiveIds.has(node.id)) continue;
      const path = this.archivePath(node.id);
      const span = messages.slice(Math.max(0, node.openedAt), node.closedAt + 1);
      const content = buildArchiveContent({ node, messages: span });
      try {
        await writeNodeArchive(this.hostFs, path, content);
        this.archivedIds.add(node.id);
      } catch (error) {
        onUnexpectedError(error);
        this.failedArchiveIds.add(node.id);
      }
    }
    await this.archiveCurrentEpochBoundary(state, messages);
  }

  private async archiveCurrentEpochBoundary(
    state: SpineState,
    messages: readonly ContextMessage[],
  ): Promise<void> {
    const epoch = state.rootEpoch;
    if (epoch <= 1) return;
    const id = String(epoch);
    if (this.archivedIds.has(id) || this.failedArchiveIds.has(id)) return;
    const memoryAt = state.epochMemoryAt;
    if (memoryAt === undefined) return;
    const summaryMessage = messages[memoryAt];
    if (summaryMessage === undefined) return;
    const content = buildEpochArchiveContent({
      epoch,
      epochStartAt: state.epochStartAt,
      epochMemoryAt: memoryAt,
      summary: stripCompactionSummaryPrefix(messageText(summaryMessage)),
      messages: messages.slice(0, memoryAt),
    });
    try {
      await writeNodeArchive(this.hostFs, this.archivePath(id), content);
      this.archivedIds.add(id);
    } catch (error) {
      onUnexpectedError(error);
      this.failedArchiveIds.add(id);
    }
  }

  private clearArchiveLedgers(): void {
    this.archivedIds.clear();
    this.failedArchiveIds.clear();
  }

  private archivePath(nodeId: string): string {
    return spineArchivePath(
      join(this.sessionCtx.sessionDir, 'agents', this.scopeContext.agentId),
      nodeId,
    );
  }
}

function topOf(state: SpineState): string {
  const top = state.openStack.at(-1);
  if (top === undefined) {
    throw new Error('Spine openStack is empty; the tree must always contain a root epoch.');
  }
  return top;
}

function messageText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function stripCompactionSummaryPrefix(text: string): string {
  if (!text.startsWith(COMPACTION_SUMMARY_PREFIX)) return text;
  return text.slice(COMPACTION_SUMMARY_PREFIX.length).replace(/^\n+/, '');
}

function reject(reason: string): SpineTransitionResult {
  return { accepted: false, reason };
}
