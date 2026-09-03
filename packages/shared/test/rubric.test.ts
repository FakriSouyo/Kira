import { describe, expect, it } from 'vitest';
import { normalizeJudgmentScore, stanceForScore } from '../src/index';

describe('normalizeJudgmentScore — rubrik 5 kategori (addendum §15/§24-A.5)', () => {
  it('renormalisasi atas 100 saat kelima kategori non-null', () => {
    const breakdown = {
      financialHealth: 80,
      growth: 60,
      valuation: 50,
      marketMomentum: 70,
      risk: 40,
    };
    const expected = Math.round((80 * 25 + 60 * 20 + 50 * 20 + 70 * 20 + 40 * 15) / 100);
    expect(normalizeJudgmentScore(breakdown)).toBe(expected);
  });

  it('renormalisasi atas 65 ketika momentum/risk null (backward-compatible, Phase 0)', () => {
    const breakdown = {
      financialHealth: 80,
      growth: 60,
      valuation: 50,
      marketMomentum: null,
      risk: null,
    };
    const expected = Math.round((80 * 25 + 60 * 20 + 50 * 20) / 65);
    expect(normalizeJudgmentScore(breakdown)).toBe(expected);
  });

  it('renormalisasi atas 80 ketika hanya risk null (degradasi parsial Market/News)', () => {
    const breakdown = {
      financialHealth: 90,
      growth: 70,
      valuation: 60,
      marketMomentum: 80,
      risk: null,
    };
    const expected = Math.round((90 * 25 + 70 * 20 + 60 * 20 + 80 * 20) / 85);
    expect(normalizeJudgmentScore(breakdown)).toBe(expected);
  });

  it('mengembalikan 0 bila semua kategori null (degenerate)', () => {
    expect(
      normalizeJudgmentScore({ financialHealth: null as unknown as number, growth: null as unknown as number, valuation: null as unknown as number, marketMomentum: null, risk: null }),
    ).toBe(0);
  });
});

describe('stanceForScore — alignment skor ↔ stance (addendum §15)', () => {
  it('>60 bullish, <40 bearish, selain itu neutral', () => {
    expect(stanceForScore(78)).toBe('bullish');
    expect(stanceForScore(25)).toBe('bearish');
    expect(stanceForScore(50)).toBe('neutral');
    expect(stanceForScore(40)).toBe('neutral');
    expect(stanceForScore(60)).toBe('neutral');
  });
});