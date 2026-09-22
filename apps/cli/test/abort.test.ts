import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workflow } from '../src/workflows/workflow';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { buildContext } from '../src/context';
import { loadConfig } from '../src/config';
import { judgeWorkflow } from '../src/workflows/judgeWorkflow';
import { getEmbedding } from '@harness/shared';

describe('Abort + getEmbedding (Phase 9A)', () => {
  it('Workflow abort throws before step', async () => {
    const w = new Workflow<{ n: number }>();
    w.step('a', async (ctx) => { ctx.n += 1; });
    const controller = new AbortController();
    controller.abort();
    await expect(w.run({ n: 0 }, undefined, { signal: controller.signal })).rejects.toThrow('Aborted');
  });

  it('judgeWorkflow abort at phase boundary throws ABORTED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'finharness-abort-'));
    const db = openDb({ homeDir: dir });
    const config = loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true });
    const ctx = buildContext(db, config, { sessionId: 'abort-test-session' });
    const controller = new AbortController();
    controller.abort();
    await expect(judgeWorkflow(ctx, 'BBCA', () => {}, () => {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('getEmbedding fallback mock deterministik', async () => {
    const e1 = await getEmbedding('hello');
    const e2 = await getEmbedding('hello');
    expect(e1).toEqual(e2);
  });

  it('getEmbedding with llm still fallback mock (offline-safe)', async () => {
    const fakeLlm = { generateText: async () => ({ text: 'ok' }) };
    const e = await getEmbedding('hello', { llm: fakeLlm as unknown as { generateText: (p: { prompt: string }) => Promise<{ text: string }> } });
    expect(e.length).toBe(8);
  });
});
