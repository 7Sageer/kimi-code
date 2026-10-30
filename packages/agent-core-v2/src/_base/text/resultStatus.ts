export const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
export const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
export const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
export const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';

export function renderTextStatus(output: string, isError?: boolean): string {
  if (isError === true) {
    return output.length === 0 ? TOOL_EMPTY_ERROR_STATUS : TOOL_ERROR_STATUS + '\n' + output;
  }
  return output.trim().length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT ? TOOL_EMPTY_STATUS : output;
}
