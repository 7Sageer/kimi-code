import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';

import { IAgentSpineService, SPINE_TOOL_CLOSE } from '#/features/spine/spine';

import { toControlResult } from './controlResult';
import { SPINE_CLOSE_DESCRIPTION } from './descriptions';
import { ISpineCloseTool, SpineCloseInputSchema, type SpineCloseInput } from './spine-close';

export class SpineCloseTool implements ISpineCloseTool {
  declare readonly _serviceBrand: undefined;
  readonly name = SPINE_TOOL_CLOSE;
  readonly description = SPINE_CLOSE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineCloseInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(input: SpineCloseInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Close the current Spine node',
      execute: async () => toControlResult(this.spine.acceptClose(input.memory)),
    };
  }
}
