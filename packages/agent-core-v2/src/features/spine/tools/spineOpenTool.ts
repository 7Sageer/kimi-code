import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';

import { IAgentSpineService, SPINE_TOOL_OPEN } from '#/features/spine/spine';

import { toControlResult } from './controlResult';
import { SPINE_OPEN_DESCRIPTION } from './descriptions';
import { ISpineOpenTool, SpineOpenInputSchema, type SpineOpenInput } from './spine-open';

export class SpineOpenTool implements ISpineOpenTool {
  declare readonly _serviceBrand: undefined;
  readonly name = SPINE_TOOL_OPEN;
  readonly description = SPINE_OPEN_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineOpenInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(input: SpineOpenInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Open a Spine child node',
      execute: async () => toControlResult(this.spine.acceptOpen(input.summary)),
    };
  }
}
