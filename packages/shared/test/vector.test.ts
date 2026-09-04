import { describe, expect, it } from 'vitest';
import { cosineSimilarity, mockEmbedding } from '../src/vector';

describe('vector helpers (Phase 7)', () => {
  it('cosineSimilarity: identical → 1, orthogonal near 0', () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1);
    const c = [0, 1, 0];
    expect(cosineSimilarity(a, c)).toBeCloseTo(0);
  });

  it('mockEmbedding deterministik & normalized', () => {
    const e1 = mockEmbedding('hello');
    const e2 = mockEmbedding('hello');
    expect(e1).toEqual(e2);
    const e3 = mockEmbedding('different');
    expect(e1).not.toEqual(e3);
    const norm = Math.sqrt(e1.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1);
  });

  it('cosineSimilarity dim mismatch throws', () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow();
  });

  it('mockEmbedding berbeda → cosine < 1', () => {
    const a = mockEmbedding('roe');
    const b = mockEmbedding('revenue');
    expect(cosineSimilarity(a, b)).toBeLessThan(1);
  });
});
