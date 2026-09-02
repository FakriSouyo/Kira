import { describe, expect, it } from 'vitest';
import { canonicalHash, canonicalJson, sortKeys } from '@harness/evidence';

describe('canonicalHash (addendum §13)', () => {
  it('key order tidak memengaruhi hash', () => {
    const a = { revenue: 100, profit: 20 };
    const b = { profit: 20, revenue: 100 };
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it('nested object & array ikut diurutkan', () => {
    const a = { meta: { b: 1, a: 2 }, items: [{ y: 1, x: 2 }, { d: 4, c: 3 }] };
    const b = { items: [{ x: 2, y: 1 }, { c: 3, d: 4 }], meta: { a: 2, b: 1 } };
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it('data berbeda → hash berbeda', () => {
    expect(canonicalHash({ revenue: 100 })).not.toBe(canonicalHash({ revenue: 101 }));
  });

  it('canonicalJson deterministik', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sortKeys tidak mengubah array of primitives urutannya', () => {
    expect(sortKeys([3, 1, 2])).toEqual([3, 1, 2]);
  });
});
