import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { buildContext } from '../src/context';
import { loadConfig } from '../src/config';
import { judgeWorkflow } from '../src/workflows/judgeWorkflow';
import { searchEvidence } from '@harness/database';
import { renderSearchResult } from '../src/repl/renderer';

describe('/search (Phase 7)', () => {
  let db: FinharnessDatabase;
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-search-'));
    db = openDb({ homeDir });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('search returns ranked evidence for query ROE', async () => {
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    const ctx = buildContext(db, config, { sessionId: 'search-test-session' });
    const art = await judgeWorkflow(ctx, 'BBCA', () => {}, () => {});
    const results = await searchEvidence(db, { runId: art.run.id, query: 'roe' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]._score).toBeGreaterThan(0);
  });

  it('limit works', async () => {
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    const ctx = buildContext(db, config, { sessionId: 'search-test-session' });
    const art = await judgeWorkflow(ctx, 'BBCA', () => {}, () => {});
    const results = await searchEvidence(db, { runId: art.run.id, query: 'BBCA', limit: 1 });
    expect(results.length).toBe(1);
  });

  it('renderSearchResult contains query and score', async () => {
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    const ctx = buildContext(db, config, { sessionId: 'search-test-session' });
    const art = await judgeWorkflow(ctx, 'BBCA', () => {}, () => {});
    const results = await searchEvidence(db, { runId: art.run.id, query: 'roe', limit: 2 });
    const out = renderSearchResult('roe', results, art.run.id);
    expect(out).toContain('roe');
    expect(out).toContain('score=');
  });

  it('search without runId uses last run', async () => {
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    const ctx = buildContext(db, config, { sessionId: 'search-test-session' });
    await judgeWorkflow(ctx, 'BBCA', () => {}, () => {});
    const results = await searchEvidence(db, { query: 'BBCA' });
    expect(results.length).toBeGreaterThan(0);
  });
});
