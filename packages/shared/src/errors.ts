/** Error yang aman ditampilkan ke user REPL (lihat addendum §21). */
export class UserFriendlyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly suggestion: string,
  ) {
    super(message);
    this.name = 'UserFriendlyError';
  }
}

/** Kegagalan validasi claim (Layer 1–3, addendum §16). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function isRetryableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'RATE_LIMIT' || code === 'TIMEOUT' || code === 'SERVER_ERROR';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
