export type ToolRuntimeErrorCode =
  | 'TOOL_INPUT_INVALID'
  | 'TOOL_OUTPUT_INVALID'
  | 'TOOL_ABORTED'
  | 'INVALID_TOOL_DEFINITION';

export class ToolRuntimeError extends Error {
  readonly code: ToolRuntimeErrorCode;
  readonly cause?: unknown;

  constructor(
    code: ToolRuntimeErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ToolRuntimeError';
    this.code = code;
    this.cause = cause;
  }
}
