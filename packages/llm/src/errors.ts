export type RuntimeErrorCode =
  | 'UNKNOWN_PROVIDER'
  | 'UNKNOWN_MODEL'
  | 'UNKNOWN_ADAPTER'
  | 'DUPLICATE_PROVIDER'
  | 'DUPLICATE_MODEL'
  | 'INVALID_RUNTIME_CONFIG'
  | 'UNSUPPORTED_OPERATION'
  | 'ABORTED'
  | 'PREPARED_CALL_ALREADY_USED';

export class RuntimeError extends Error {
  readonly name = 'ModelRuntimeError';

  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${message}`, options);
  }
}
