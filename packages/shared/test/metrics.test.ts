import { describe, expect, it } from 'vitest';
import { formatDuration } from '../src/metrics';

describe('formatDuration (Phase 5 Task 2)', () => {
  it('null → 0.0s', () => {
    expect(formatDuration(null)).toBe('0.0s');
    expect(formatDuration(undefined)).toBe('0.0s');
  });

  it('formats 12.345 → 12.3s', () => {
    expect(formatDuration(12.345)).toBe('12.3s');
  });

  it('formats <1s', () => {
    expect(formatDuration(0.8)).toBe('0.8s');
    expect(formatDuration(0)).toBe('0.0s');
  });
});
