export const DEFAULT_TOOL_RESULT_MAX_CHARS = 50_000;

export const DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS = 10_000_000;

export interface ToolResultSpill {
  readonly outputPath?: string;
  readonly totalChars?: number;
  readonly suffix?: string;
}
