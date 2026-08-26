import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SPINE_FLAG_ID = 'spine';
export const SPINE_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SPINE';

export const spineFlag: FlagDefinitionInput = {
  id: SPINE_FLAG_ID,
  title: 'Spine (tree-of-work)',
  description:
    'Let the main agent self-declare task boundaries with the spine_open / spine_close / spine_next tools; closed spans fold into model-written memory in the projected context while the stored history stays untouched.',
  env: SPINE_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(spineFlag);
