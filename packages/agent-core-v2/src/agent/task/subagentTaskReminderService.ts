import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { WAIT_FOR_FLAG_ID } from '#/agent/tools/task/task-wait/flag';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type { ReminderRegistration } from '#/features/reminder/types';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

export const SUBAGENT_BACKGROUND_TASK_NOTICE =
  'You are running as a subagent: ending your turn is your final hand-off to the parent agent, and completion notifications that arrive after it reach no one. Do not end your turn while a background task whose result you need is still running. Keep waiting for it with WaitFor, calling it again after a timeout if needed, or run the command in the foreground with a suitable timeout instead. Still use the waiting time for other useful work on your task when you can.';

export interface IAgentSubagentTaskReminderService {
  readonly _serviceBrand: undefined;

  disable(): void;
}

export const IAgentSubagentTaskReminderService =
  createDecorator<IAgentSubagentTaskReminderService>('agentSubagentTaskReminderService');

export class AgentSubagentTaskReminderService extends Service implements IAgentSubagentTaskReminderService {
  declare readonly _serviceBrand: undefined;
  private readonly registration?: ReminderRegistration;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IFlagService flags: IFlagService,
    @IAgentToolRegistryService tools: IAgentToolRegistryService,
    @IAgentToolPolicyService policy: IAgentToolPolicyService,
    @IAgentReminderService reminder: IAgentReminderService,
  ) {
    super();
    if (scopeContext.agentId === MAIN_AGENT_ID) return;
    this.registration = this._register(
      reminder.register('subagent_background_task', ({ lastInjectedAt }) => {
        if (
          lastInjectedAt !== null ||
          !flags.enabled(WAIT_FOR_FLAG_ID) ||
          tools.resolve('WaitFor') === undefined ||
          !policy.isToolActive('WaitFor')
        ) return undefined;
        return SUBAGENT_BACKGROUND_TASK_NOTICE;
      }),
    );
  }

  disable(): void {
    this.registration?.dispose();
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSubagentTaskReminderService,
  AgentSubagentTaskReminderService,
  ScopeActivation.OnScopeCreated,
  'task',
);
