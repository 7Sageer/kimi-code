import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

import { SPINE_NEXT_SUMMARY_DESCRIPTION, SPINE_NODE_MEMORY_DESCRIPTION } from './descriptions';

export interface SpineNextInput {
  readonly summary: string;
  readonly memory: string;
}

export const SpineNextInputSchema: z.ZodType<SpineNextInput> = z.object({
  summary: z.string().min(1).describe(SPINE_NEXT_SUMMARY_DESCRIPTION),
  memory: z.string().min(1).describe(SPINE_NODE_MEMORY_DESCRIPTION),
});

export interface ISpineNextTool extends AgentTool<SpineNextInput> {
  readonly _serviceBrand: undefined;
}
export const ISpineNextTool = createDecorator<ISpineNextTool>('spineNextTool');
