import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { buildContext } from '../src/context';
import { loadConfig } from '../src/config';
import { judgeWorkflow } from '../src/workflows/judgeWorkflow';

describe('judgeWorkflow conditional debate (Phase 3 Task 2)', () => {
  let db: FinharnessDatabase;
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-conditional-'));
    db = openDb({ homeDir });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  function baseCtx() {
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    return buildContext(db, config);
  }

  it('tanpa --conditional tetap 5 messages (0–4) meski score neutral', async () => {
    const ctx = baseCtx();
    // Override judge agar selalu neutral 50
    let calls = 0;
    const orig = ctx.judge.evaluate.bind(ctx.judge);
    ctx.judge.evaluate = async (p: Parameters<typeof orig>[0]) => {
      calls++;
      // pertama neutral, kedua juga neutral — tapi tanpa conditional tidak akan terpanggil kedua kali
      return { value: {
        ticker: p.ticker,
        score: 50,
        stance: 'neutral' as const,
        confidence: 'moderate' as const,
        breakdown: { financialHealth: 50, growth: 50, valuation: 50, marketMomentum: null, risk: null },
        summary: `Neutral mock ${calls}`,
      }, subagent: 'judge', skills: [{ name: 'evidence-weighing', contentHash: 'test-hash' }] };
    };
    const art = await judgeWorkflow(ctx, 'BBCA', () => {}, () => {}, { conditional: false });
    const msgs = await db.conversation.getByRun(art.run.id);
    expect(msgs.length).toBe(5);
    expect(msgs.map((m) => m.sequenceOrder)).toEqual([0, 1, 2, 3, 4]);
    expect(calls).toBe(1);
  });

  it('dengan --conditional + neutral → extra round (bear2, bull2, judge2) + judgment overwrite', async () => {
    const ctx = baseCtx();
    let judgeCalls = 0;
    const orig = ctx.judge.evaluate.bind(ctx.judge);
    // Skor harus konsisten dengan breakdown: `synthesize-verdict` menegakkan
    // re-derivasi rubrik deterministik (PR C), sama seperti JudgeAgent asli.
    ctx.judge.evaluate = async (p: Parameters<typeof orig>[0]) => {
      judgeCalls++;
      if (judgeCalls === 1) {
        return { value: {
          ticker: p.ticker,
          score: 51,
          stance: 'neutral' as const,
          confidence: 'moderate' as const,
          breakdown: { financialHealth: 50, growth: 52, valuation: 51, marketMomentum: null, risk: null },
          summary: 'First neutral',
        }, subagent: 'judge', skills: [{ name: 'evidence-weighing', contentHash: 'test-hash' }] };
      }
      return { value: {
        ticker: p.ticker,
        score: 72,
        stance: 'bullish' as const,
        confidence: 'moderate' as const,
        breakdown: { financialHealth: 72, growth: 72, valuation: 72, marketMomentum: null, risk: null },
        summary: 'Second bullish after conditional',
      }, subagent: 'judge', skills: [{ name: 'evidence-weighing', contentHash: 'test-hash' }] };
    };
    const art = await judgeWorkflow(ctx, 'BBCA', () => {}, () => {}, { conditional: true });
    const msgs = await db.conversation.getByRun(art.run.id);
    // 5 base + 3 conditional = 8 messages (0–7)
    expect(msgs.length).toBe(8);
    expect(msgs.map((m) => m.sequenceOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(judgeCalls).toBe(2);
    // judgment overwrite via upsert → final bullish
    expect(art.judgment.stance).toBe('bullish');
    expect(art.judgment.score).toBe(72);
    const stored = await db.judgments.getByRun(art.run.id);
    expect(stored?.stance).toBe('bullish');
  });

  it('dengan --conditional tapi score bullish → tidak ada extra round', async () => {
    const ctx = baseCtx();
    // gunakan judge asli (BBCA mock menghasilkan bullish) — tidak neutral
    const art = await judgeWorkflow(ctx, 'BBCA', () => {}, () => {}, { conditional: true });
    const msgs = await db.conversation.getByRun(art.run.id);
    expect(msgs.length).toBe(5);
    expect(art.judgment.stance).toBe('bullish');
  });
});
