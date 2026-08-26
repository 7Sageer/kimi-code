import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const SpineTreeInputSchema = z.object({});

export interface ISpineTreeTool extends AgentTool<Record<string, never>> {
  readonly _serviceBrand: undefined;
}
export const ISpineTreeTool = createDecorator<ISpineTreeTool>('spineTreeTool');
