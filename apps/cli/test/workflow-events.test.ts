import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { buildContext } from '../src/context';
import { loadConfig } from '../src/config';
import { judgeWorkflow } from '../src/workflows/judgeWorkflow';
import { serializeAgentEvent, type AgentEvent } from '../src/repl/events';

/**
 * Integrasi Agent-Events JSONL di judgeWorkflow (Phase 2 Task 2).
 * Context dibangun deterministik (mock sectors + mock LLM) — tak butuh API key
 * maupun network. Assert menegakkan bahwa event penting muncul (bukan urutan
 * ketat), dan bahwa semua varian JSONL valid round-trip.
 */
describe('judgeWorkflow → Agent-Events (Phase 2 Task 2)', () => {
  let db: FinharnessDatabase;
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-events-test-'));
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    db = openDb({ homeDir });
    (globalThis as { _eventsCtx?: unknown })._eventsCtx = buildContext(db, config);
  });

  afterEach(() => {
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
    delete (globalThis as { _eventsCtx?: unknown })._eventsCtx;
  });

  function ctx(): ReturnType<typeof buildContext> {
    return (globalThis as { _eventsCtx: ReturnType<typeof buildContext> })._eventsCtx;
  }

  it('meng-emit session/phase/tool/evidence pada run /judge yang sukses', async () => {
    const events: AgentEvent[] = [];
    const artifact = await judgeWorkflow(ctx(), 'BBCA', () => {}, (e) => events.push(e));

    const types = events.map((e) => e.type);
    // session berpasangan start→complete; run boleh selesai completed
    expect(types).toContain('session.start');
    expect(types).toContain('session.complete');
    const sessionStart = events.find((e) => e.type === 'session.start');
    const sessionComplete = events.find((e) => e.type === 'session.complete');
    expect(sessionComplete && sessionComplete.type === 'session.complete' && sessionComplete.status).toBe('completed');
    expect(sessionStart && sessionStart.type === 'session.start' && sessionStart.runId).toBe(artifact.run.id);

    // phase researcher + minimal satu fase agent
    expect(types).toContain('phase');
    expect(events.filter((e) => e.type === 'phase').map((e) => (e.type === 'phase' ? e.phase : null))).toContain('researcher');

    // fundamental tool (company_report) start+complete
    expect(types).toContain('tool.start');
    expect(types).toContain('tool.complete');
    expect(events.some((e) => e.type === 'tool.start' && e.tool === 'company_report')).toBe(true);
    expect(events.some((e) => e.type === 'tool.complete' && e.tool === 'company_report')).toBe(true);

    // evidence.found utk source fundamental
    expect(types).toContain('evidence.found');
    expect(events.some((e) => e.type === 'evidence.found' && e.source === 'sectors.company_report')).toBe(true);

    // seluruh event harus valid satu baris JSON (round-trip)
    for (const ev of events) expect(JSON.parse(serializeAgentEvent(ev))).toEqual(ev);
  });

  it('meng-emit session.complete failed bila workflow gagal', async () => {
    const events: AgentEvent[] = [];
    // FATAL pada run fundamental: mock akan throw NOT_FOUND untuk ticker tak dikenal.
    await expect(
      judgeWorkflow(ctx(), 'ZZZZ', () => {}, (e) => events.push(e)),
    ).rejects.toThrow();

    const complete = events.find((e) => e.type === 'session.complete');
    expect(complete && complete.type === 'session.complete' && complete.status).toBe('failed');
    expect(events.some((e) => e.type === 'session.start')).toBe(true);
  });
});