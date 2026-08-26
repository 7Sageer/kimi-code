import type { ExecutableToolResult } from '#/tool/toolContract';

import type { SpineTransitionResult } from '#/features/spine/spine';

export const ACCEPTED_OUTPUT = 'accepted — commits after this step completes';

export function toControlResult(result: SpineTransitionResult): ExecutableToolResult {
  if (result.accepted) return { isError: false, output: ACCEPTED_OUTPUT };
  return { isError: true, output: result.reason };
}
