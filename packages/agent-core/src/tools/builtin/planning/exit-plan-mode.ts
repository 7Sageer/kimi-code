/**
 * ExitPlanModeTool — plan-mode exit tool.
 *
 * The LLM calls this tool to surface a finalised plan to the user and
 * exit plan mode. The plan must already be written to the current plan
 * file; this tool reads that file and flips plan mode off. PermissionManager
 * handles plan approval before this tool runs and passes the approval outcome
 * through execution metadata.
 */

import type { Agent } from '#/agent';
import type { PlanData } from '#/agent/plan';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { ToolInputDisplay } from '../../display';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './exit-plan-mode.md';

// ── Input schema ─────────────────────────────────────────────────────

/**
 * User-selectable option surfaced at plan approval time. The LLM supplies
 * up to 3 of these when the plan contains multiple approaches; the host's
 * ApprovalRuntime presents them to the user and returns the chosen `label`
 * (or `{kind:'revise', feedback}` when the user asks for revisions).
 */
export interface ExitPlanModeOption {
  label: string;
  description: string;
}

export interface ExitPlanModeInput {
  options?: readonly ExitPlanModeOption[] | undefined;
}

const RESERVED_OPTION_LABELS = new Set(
  ['Approve', 'Reject', 'Reject and Exit', 'Revise'].map(normalizeOptionLabel),
);

const ExitPlanModeOptionSchema = z
  .object({
    label: z
      .string()
      .min(1)
      .max(80)
      .describe(
        'Short name for this option (1-8 words). Append "(Recommended)" if you recommend this option.',
      ),
    description: z
      .string()
      .default('')
      .describe('Brief summary of this approach and its trade-offs.'),
  })
  .strict();

export const ExitPlanModeInputSchema: z.ZodType<ExitPlanModeInput> = z
  .object({
    options: z
      .array(ExitPlanModeOptionSchema)
      .min(1)
      .max(3)
      .refine(hasUniqueOptionLabels, 'Option labels must be unique.')
      .refine(hasNoReservedOptionLabels, 'Option labels must not use reserved approval labels.')
      .optional()
      .describe(
        'When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use "Reject", "Revise", "Approve", or "Reject and Exit" as labels.',
      ),
  })
  .strict();

export interface ExitPlanModePlanSource {
  plan: string;
  path?: string | undefined;
}

type ResolvePlanResult =
  | { readonly ok: true; readonly plan: string; readonly path?: string | undefined }
  | { readonly ok: false; readonly error: ExecutableToolResult };

interface PlanApprovalMetadata {
  readonly decision: 'approved' | 'rejected' | 'cancelled';
  readonly selectedLabel?: string;
  readonly feedback?: string;
}

// ── Implementation ───────────────────────────────────────────────────

export class ExitPlanModeTool implements BuiltinTool<ExitPlanModeInput> {
  readonly name = 'ExitPlanMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ExitPlanModeInputSchema);

  constructor(private readonly agent: Agent) {}

  async resolveExecution(args: ExitPlanModeInput): Promise<ToolExecution> {
    return {
      description: 'Presenting plan and exiting plan mode',
      display: await this.resolvePlanReviewDisplay(args),
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async resolvePlanReviewDisplay(
    args: ExitPlanModeInput,
  ): Promise<ToolInputDisplay | undefined> {
    if (!this.agent.planMode.isActive) return undefined;
    let data: PlanData;
    try {
      data = await this.agent.planMode.data();
    } catch {
      return undefined;
    }
    if (data === null || data.content.trim().length === 0) return undefined;
    const display: ToolInputDisplay = {
      kind: 'plan_review',
      plan: data.content,
      path: data.path,
    };
    if (args.options !== undefined && args.options.length >= 2) {
      display.options = args.options;
    }
    return display;
  }

  private async execution(
    args: ExitPlanModeInput,
    {
    metadata,
    }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    if (!this.agent.planMode.isActive) {
      return {
        isError: true,
        output:
          'ExitPlanMode can only be called while plan mode is active. Use EnterPlanMode (or /plan) first.',
      };
    }

    const resolvedPlan = await this.resolvePlan();
    if (!resolvedPlan.ok) return resolvedPlan.error;

    if (!planTelemetryWasSubmitted(metadata)) {
      this.agent.telemetry.track('plan_submitted', {
        has_options: args.options !== undefined && args.options.length >= 2,
      });
    }
    const planApproval = planApprovalFromMetadata(metadata);
    if (planApproval !== undefined) {
      trackPlanApprovalResolution(this.agent, planApproval);
      if (planApproval.decision !== 'approved') {
        return this.planApprovalRejectedResult(planApproval);
      }
      return this.exitWithPlan(
        resolvedPlan.plan,
        resolvedPlan.path,
        selectedOptionFromMetadata(metadata),
        true,
      );
    }
    return this.exitWithPlan(
      resolvedPlan.plan,
      resolvedPlan.path,
      selectedOptionFromMetadata(metadata),
      planTelemetryWasResolved(metadata),
    );
  }

  private async exitWithPlan(
    plan: string,
    path: string | undefined,
    option: ExitPlanModeOption | undefined = undefined,
    telemetryResolved = false,
  ): Promise<ExecutableToolResult> {
    const failed = this.exitPlanMode();
    if (failed !== undefined) return failed;

    if (!telemetryResolved) {
      this.agent.telemetry.track('plan_resolved', { outcome: 'auto_approved' });
    }
    const optionPrefix =
      option === undefined
        ? ''
        : `Selected approach: ${option.label}\nExecute ONLY the selected approach. Do not execute any unselected alternatives.\n\n`;
    return {
      isError: false,
      output: `Exited plan mode. ${optionPrefix}${formatPlanForOutput(plan, path)}`,
    };
  }

  private planApprovalRejectedResult(approval: PlanApprovalMetadata): ExecutableToolResult {
    if (approval.decision === 'cancelled') {
      return {
        isError: false,
        output: 'Plan approval dismissed. Plan mode remains active.',
      };
    }

    if (normalizeOptionLabel(approval.selectedLabel ?? '') === 'reject and exit') {
      const failed = this.exitPlanMode();
      return (
        failed ?? {
          isError: true,
          stopTurn: true,
          output: 'Plan rejected by user. Plan mode deactivated.',
        }
      );
    }

    const feedback = approval.feedback ?? '';
    if (normalizeOptionLabel(approval.selectedLabel ?? '') === 'revise' || feedback.length > 0) {
      return {
        isError: false,
        output:
          feedback.length > 0
            ? `User rejected the plan. Feedback:\n\n${feedback}`
            : 'User requested revisions. Plan mode remains active.',
      };
    }

    return {
      isError: true,
      stopTurn: true,
      output: 'Plan rejected by user. Plan mode remains active.',
    };
  }

  private exitPlanMode(): ExecutableToolResult | undefined {
    try {
      this.agent.planMode.exit();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to exit plan mode.';
      return {
        isError: true,
        output: `Failed to exit plan mode: ${message}`,
      };
    }
  }

  private async resolvePlan(): Promise<ResolvePlanResult> {
    let source: ExitPlanModePlanSource | null;
    try {
      const data = await this.agent.planMode.data();
      source = data === null ? null : { plan: data.content, path: data.path };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read plan file.';
      return {
        ok: false,
        error: { isError: true, output: `Failed to read plan file: ${message}` },
      };
    }

    if (source !== null && source.plan.trim().length > 0) {
      return {
        ok: true,
        plan: source.plan,
        path: source.path,
      };
    }

    const path = source?.path ?? this.agent.planMode.planFilePath;
    return {
      ok: false,
      error: {
        isError: true,
        output:
          path === null
            ? 'No plan file found. Write the plan to the current plan file first, then call ExitPlanMode.'
            : `No plan file found. Write your plan to ${path} first, then call ExitPlanMode.`,
      },
    };
  }
}

function hasUniqueOptionLabels(options: readonly ExitPlanModeOption[]): boolean {
  const labels = new Set<string>();
  for (const option of options) {
    const label = normalizeOptionLabel(option.label);
    if (labels.has(label)) return false;
    labels.add(label);
  }
  return true;
}

function hasNoReservedOptionLabels(options: readonly ExitPlanModeOption[]): boolean {
  return options.every((option) => !RESERVED_OPTION_LABELS.has(normalizeOptionLabel(option.label)));
}

function normalizeOptionLabel(label: string): string {
  return label.trim().toLowerCase();
}

function selectedOptionFromMetadata(metadata: unknown): ExitPlanModeOption | undefined {
  if (metadata === null || typeof metadata !== 'object') return undefined;
  const selectedOption = (metadata as { readonly selectedOption?: unknown }).selectedOption;
  if (selectedOption === null || typeof selectedOption !== 'object') return undefined;
  const label = (selectedOption as { readonly label?: unknown }).label;
  const description = (selectedOption as { readonly description?: unknown }).description;
  if (typeof label !== 'string' || typeof description !== 'string') return undefined;
  return { label, description };
}

function planApprovalFromMetadata(metadata: unknown): PlanApprovalMetadata | undefined {
  if (metadata === null || typeof metadata !== 'object') return undefined;
  const planApproval = (metadata as { readonly planApproval?: unknown }).planApproval;
  if (planApproval === null || typeof planApproval !== 'object') return undefined;
  const decision = (planApproval as { readonly decision?: unknown }).decision;
  if (decision !== 'approved' && decision !== 'rejected' && decision !== 'cancelled') {
    return undefined;
  }
  const selectedLabel = (planApproval as { readonly selectedLabel?: unknown }).selectedLabel;
  const feedback = (planApproval as { readonly feedback?: unknown }).feedback;
  return {
    decision,
    selectedLabel: typeof selectedLabel === 'string' ? selectedLabel : undefined,
    feedback: typeof feedback === 'string' ? feedback : undefined,
  };
}

function trackPlanApprovalResolution(agent: Agent, approval: PlanApprovalMetadata): void {
  const selectedLabel = approval.selectedLabel ?? '';
  const normalizedSelectedLabel = normalizeOptionLabel(selectedLabel);
  const feedback = approval.feedback ?? '';
  const hasFeedback = feedback.length > 0;

  if (approval.decision === 'cancelled') {
    agent.telemetry.track('plan_resolved', { outcome: 'dismissed' });
    return;
  }

  if (approval.decision === 'approved') {
    if (selectedLabel.length > 0) {
      agent.telemetry.track('plan_resolved', {
        outcome: 'approved',
        chosen_option: selectedLabel,
      });
      return;
    }
    agent.telemetry.track('plan_resolved', { outcome: 'approved' });
    return;
  }

  if (normalizedSelectedLabel === 'reject and exit') {
    agent.telemetry.track('plan_resolved', { outcome: 'rejected_and_exited' });
    return;
  }

  if (normalizedSelectedLabel === 'revise' || hasFeedback) {
    agent.telemetry.track('plan_resolved', {
      outcome: 'revise',
      has_feedback: hasFeedback,
    });
    return;
  }

  agent.telemetry.track('plan_resolved', { outcome: 'rejected' });
}

function planTelemetryWasSubmitted(metadata: unknown): boolean {
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    (metadata as { readonly planTelemetrySubmitted?: unknown }).planTelemetrySubmitted === true
  );
}

function planTelemetryWasResolved(metadata: unknown): boolean {
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    (metadata as { readonly planTelemetryResolved?: unknown }).planTelemetryResolved === true
  );
}

function formatPlanForOutput(plan: string, path: string | undefined): string {
  const savedTo = path !== undefined ? `Plan saved to: ${path}\n\n` : '';
  return `Plan mode deactivated. All tools are now available.\n${savedTo}## Approved Plan:\n${plan}`;
}
