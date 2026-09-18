export type FinancialDataErrorCode =
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'SERVER_ERROR'
  | 'NETWORK';

/** Provider-neutral failure shape preserved through composition error mapping. */
export class FinancialDataError extends Error {
  constructor(
    public readonly code: FinancialDataErrorCode,
    message: string,
    public readonly suggestion: string,
  ) {
    super(message);
    this.name = 'FinancialDataError';
  }
}
