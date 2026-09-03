import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { buildContext } from '../src/context';
import { loadConfig } from '../src/config';
import { judgeWorkflow } from '../src/workflows/judgeWorkflow';
import { makeHistoryCommand, makeSessionCommand } from '../src/commands/history';

describe('/history + /session (Phase 4 Task 1)', () => {
  let db: FinharnessDatabase;
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-history-'));
    db = openDb({ homeDir });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  function ctx() {
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    return buildContext(db, config);
  }

  it('history lists runs after /judge', async () => {
    const art = await judgeWorkflow(ctx(), 'BBCA', () => {}, () => {});
    const history = makeHistoryCommand(ctx());
    let out = '';
    const origWrite = process.stdout.write;
    (process.stdout.write as unknown) = (s: string) => { out += s; return true; };
    try {
      await history([]);
    } finally {
      process.stdout.write = origWrite;
    }
    expect(out).toContain(art.run.id);
    expect(out).toContain('BBCA');
  });

  it('session shows judgment markdown for existing run', async () => {
    const art = await judgeWorkflow(ctx(), 'BBCA', () => {}, () => {});
    const session = makeSessionCommand(ctx());
    let out = '';
    const origWrite = process.stdout.write;
    (process.stdout.write as unknown) = (s: string) => { out += s; return true; };
    try {
      await session([art.run.id]);
    } finally {
      process.stdout.write = origWrite;
    }
    expect(out).toContain('FINAL JUDGMENT');
    expect(out).toContain(art.run.id);
  });

  it('session NOT_FOUND untuk run tak ada', async () => {
    const session = makeSessionCommand(ctx());
    await expect(session(['run_nope'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
