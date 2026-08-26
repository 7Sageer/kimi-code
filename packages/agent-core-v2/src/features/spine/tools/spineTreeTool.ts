import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';

import { IAgentSpineService, SPINE_TOOL_TREE } from '#/features/spine/spine';

import { SPINE_TREE_DESCRIPTION } from './descriptions';
import { ISpineTreeTool, SpineTreeInputSchema } from './spine-tree';

export class SpineTreeTool implements ISpineTreeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = SPINE_TOOL_TREE;
  readonly description = SPINE_TREE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineTreeInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Inspect the Spine tree',
      execute: async () => ({ isError: false, output: this.spine.renderTree() }),
    };
  }
}
