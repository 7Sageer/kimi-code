import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

import { SPINE_NODE_MEMORY_DESCRIPTION } from './descriptions';

export interface SpineCloseInput {
  readonly memory: string;
}

export const SpineCloseInputSchema: z.ZodType<SpineCloseInput> = z.object({
  memory: z.string().min(1).describe(SPINE_NODE_MEMORY_DESCRIPTION),
});

export interface ISpineCloseTool extends AgentTool<SpineCloseInput> {
  readonly _serviceBrand: undefined;
}
export const ISpineCloseTool = createDecorator<ISpineCloseTool>('spineCloseTool');
