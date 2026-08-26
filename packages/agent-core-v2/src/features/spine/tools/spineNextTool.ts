import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';

import { IAgentSpineService, SPINE_TOOL_NEXT } from '#/features/spine/spine';

import { toControlResult } from './controlResult';
import { SPINE_NEXT_DESCRIPTION } from './descriptions';
import { ISpineNextTool, SpineNextInputSchema, type SpineNextInput } from './spine-next';

export class SpineNextTool implements ISpineNextTool {
  declare readonly _serviceBrand: undefined;
  readonly name = SPINE_TOOL_NEXT;
  readonly description = SPINE_NEXT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineNextInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(input: SpineNextInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Finish this node and open the next sibling',
      execute: async () =>
        toControlResult(this.spine.acceptNext(input.summary, input.memory)),
    };
  }
}
