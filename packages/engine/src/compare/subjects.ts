const IDX_TICKER_PATTERN = /^[A-Z]{2,6}$/;

/** Trims, uppercases, and validates an ordered set of two or three unique IDX tickers. */
export function normalizeComparisonSubjects(subjects: readonly string[]): string[] {
  if (!Array.isArray(subjects) || subjects.length < 2 || subjects.length > 3) {
    throw new Error('Comparison requires two or three IDX subjects');
  }
  const normalized = subjects.map(subject => typeof subject === 'string' ? subject.trim().toUpperCase() : '');
  if (normalized.some(ticker => !IDX_TICKER_PATTERN.test(ticker))) {
    throw new Error('Comparison subjects must be valid IDX tickers');
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Comparison subjects must be unique');
  }
  return normalized;
}
