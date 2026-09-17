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

/**
 * Single source-of-truth mapper unknown → UserFriendlyError (addendum §21).
 * Dipakai workflow & REPL — jangan duplikat logic 401/404/429/5xx di dua tempat.
 * Cek duck-typing (code/statusCode/url) agar tidak depend ke sectors-api/llm.
 */
export function mapToUserFriendly(error: unknown, fallbackSuggestion = 'Cek output di atas atau coba lagi.'): UserFriendlyError {
  if (error instanceof UserFriendlyError) return error;
  const chain = new Set<unknown>();
  let nested = error as { cause?: unknown } | undefined;
  while (nested?.cause && !chain.has(nested.cause)) {
    chain.add(nested); error = nested.cause; nested = error as typeof nested;
  }
  // SectorsApiError atau LLM error yang sudah berbentuk UserFriendly shape
  const maybeCode = (error as { code?: string; suggestion?: string } | null);
  if (maybeCode?.code && maybeCode?.suggestion && error instanceof Error) {
    return new UserFriendlyError(maybeCode.code, error.message, maybeCode.suggestion);
  }
  if (error instanceof ValidationError) {
    return new UserFriendlyError('EVIDENCE_HALLUCINATION', error.message, fallbackSuggestion);
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const url = (error as { url?: string })?.url ?? '';
  const status = (error as { statusCode?: number })?.statusCode;

  if (status === 402 || /insufficient[_ ]?(balance|quota|credit|fund)|quota exceeded|payment required/.test(lower)) {
    return new UserFriendlyError('LLM_INSUFFICIENT_BALANCE', `Provider balance or quota exhausted${status ? ` (HTTP ${status})` : ''}.`, 'Check provider billing/credits or select another model with Tab.');
  }
  if (/out of capacity|overloaded|capacity exceeded/.test(lower)) {
    return new UserFriendlyError('LLM_CAPACITY', `Provider has no capacity${status ? ` (HTTP ${status})` : ''}.`, 'Try again later or select another model with Tab.');
  }
  if (/no object generated|no response|did not return a response/.test(lower)) {
    return new UserFriendlyError('LLM_EMPTY_RESPONSE', 'The model returned no usable structured response.', 'Check the model supports structured output. Try another model or check its output-token limit; no billing or authentication error was reported.');
  }
  if ((error as { name?: string })?.name === 'ZodError' || /unexpected end of json|json parse|invalid json/.test(lower)) {
    return new UserFriendlyError('LLM_OUTPUT_INVALID', 'The model response ended before a valid structured result was available.', 'Retry once or select a model with a larger output capacity. Provider authentication and Sectors data were not the cause.');
  }

  if (message.includes('API key is missing') || message.includes('apiKey') || message.includes('OPENAI_API_KEY')) {
    return new UserFriendlyError('MISSING_API_KEY', 'AI provider not configured', 'Run /auth-set LLM.AGENT=sk-... LLM.ROUTER=sk-... or use --mock-llm for offline demo');
  }
  if (status === 401 || status === 403 || lower.includes('incorrect api key') || lower.includes('invalid_api_key') || lower.includes('unauthorized')) {
    const hint = url ? ` (endpoint: ${url})` : '';
    return new UserFriendlyError('LLM_AUTH_FAILED', `LLM authentication failed (HTTP ${status ?? 401})${hint}`, 'Check the provider API key and model access in /setup.');
  }
  if (status === 404 || lower.includes('not found')) {
    const hint = url ? ` URL: ${url}` : '';
    const modelHint = message.includes('deepseek-v4-flash') ? ' Model "deepseek-v4-flash" does not exist.' : '';
    return new UserFriendlyError('LLM_NOT_FOUND', `LLM endpoint or model not found (404)${hint}.${modelHint}`, 'Fix config.json: base_url should be empty for OpenAI, https://api.deepseek.com for DeepSeek, or https://openrouter.ai/api/v1 for OpenRouter. Model should be gpt-4o / gpt-4o-mini / deepseek-chat / claude-3-5-sonnet. Or run with --mock-llm. Check /providers and /status');
  }
  if (status === 429 || lower.includes('rate limit')) {
    return new UserFriendlyError('LLM_RATE_LIMIT', 'LLM rate limit (429)', 'Wait a minute or check quota/billing');
  }
  if (status !== undefined && status >= 500) {
    return new UserFriendlyError('LLM_SERVER_ERROR', `LLM server error (${status}): ${message.slice(0, 200)}`, 'Provider lagi down/timeout. Coba lagi nanti, ganti model/provider, atau pakai --mock-llm');
  }
  if (lower.includes('service unavailable') || lower.includes('upstream connect error') || lower.includes('503') || lower.includes('failed after 3 attempts')) {
    return new UserFriendlyError('LLM_SERVER_ERROR', `LLM service unavailable: ${message.slice(0, 200)}`, 'Provider lagi timeout. Coba model lain, ganti base_url, atau pakai --mock-llm untuk demo');
  }
  return new UserFriendlyError('UNKNOWN_ERROR', message, fallbackSuggestion);
}
