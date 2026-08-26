import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

import { SPINE_OPEN_SUMMARY_DESCRIPTION } from './descriptions';

export interface SpineOpenInput {
  readonly summary: string;
}

export const SpineOpenInputSchema: z.ZodType<SpineOpenInput> = z.object({
  summary: z.string().min(1).describe(SPINE_OPEN_SUMMARY_DESCRIPTION),
});

export interface ISpineOpenTool extends AgentTool<SpineOpenInput> {
  readonly _serviceBrand: undefined;
}
export const ISpineOpenTool = createDecorator<ISpineOpenTool>('spineOpenTool');
