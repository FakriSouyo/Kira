import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { buildContext } from '../src/context';
import { loadConfig } from '../src/config';
import { judgeWorkflow } from '../src/workflows/judgeWorkflow';
import { createWebServer } from '../src/repl/web';

describe('Web preview (Phase 4 Task 2)', () => {
  let db: FinharnessDatabase;
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-web-'));
    db = openDb({ homeDir });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('GET / 200 HTML', async () => {
    const { server } = createWebServer(db, { port: 0 });
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://localhost:${addr.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('History');
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('GET /api/history 200 JSON', async () => {
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    const ctx = buildContext(db, config, { sessionId: 'web-test-session' });
    await judgeWorkflow(ctx, 'BBCA', () => {}, () => {});
    const { server } = createWebServer(db, { port: 0 });
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://localhost:${addr.port}/api/history`);
    expect(res.status).toBe(200);
    const json = await res.json() as unknown[];
    expect(json.length).toBeGreaterThan(0);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('GET /api/run/:id 200/404', async () => {
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    const ctx = buildContext(db, config, { sessionId: 'web-test-session' });
    const art = await judgeWorkflow(ctx, 'BBCA', () => {}, () => {});
    const { server } = createWebServer(db, { port: 0 });
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address() as { port: number };
    const ok = await fetch(`http://localhost:${addr.port}/api/run/${art.run.id}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveProperty('run');
    const bad = await fetch(`http://localhost:${addr.port}/api/run/nope`);
    expect(bad.status).toBe(404);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
