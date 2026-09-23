const NUMERIC_TOLERANCE = 0.5;

/** Supported literal assertions stay deliberately narrow: %, x, and bps. */
export function numericAssertions(statement: string): number[] {
  const values: number[] = [];
  const pattern = /(?<![\w.])-?\d+(?:\.\d+)?\s*(?:%|x|bps)(?![\w])/gi;
  for (const match of statement.matchAll(pattern)) {
    const value = Number.parseFloat(match[0]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

/** Resolve only simple property and numeric array-index paths used by CitedFigures. */
export function numericValueAtPath(data: unknown, path: string): unknown {
  if (!/^[a-zA-Z_$][\w$]*(?:(?:\.(?:[a-zA-Z_$][\w$]*|\d+))|(?:\[\d+\]))*$/.test(path)) return undefined;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function matchesGroundedNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= NUMERIC_TOLERANCE;
}
