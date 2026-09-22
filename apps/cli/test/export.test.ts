import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { buildContext } from '../src/context';
import { loadConfig } from '../src/config';
import { judgeWorkflow } from '../src/workflows/judgeWorkflow';
import { makeExportCommand } from '../src/commands/export';

describe('/export (Phase 2 Task 3)', () => {
  let db: FinharnessDatabase;
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-export-test-'));
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    db = openDb({ homeDir });
    (globalThis as { _exportCtx?: ReturnType<typeof buildContext> })._exportCtx = buildContext(db, config, { sessionId: 'export-test-session' });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
    delete (globalThis as { _exportCtx?: unknown })._exportCtx;
    vi.restoreAllMocks();
  });

  function ctx(): ReturnType<typeof buildContext> {
    return (globalThis as { _exportCtx: ReturnType<typeof buildContext> })._exportCtx;
  }

  async function createRun(): Promise<string> {
    const art = await judgeWorkflow(ctx(), 'BBCA', () => {}, () => {});
    return art.run.id;
  }

  it('export json berisi run.id dan judgment', async () => {
    const runId = await createRun();
    const handler = makeExportCommand(ctx());
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    await handler([runId, '--format', 'json']);
    spy.mockRestore();
    const parsed = JSON.parse(out);
    expect(parsed.run.id).toBe(runId);
    expect(parsed.judgment).not.toBeNull();
  });

  it('export md berisi BBCA · FINAL JUDGMENT dan Breakdown', async () => {
    const runId = await createRun();
    const handler = makeExportCommand(ctx());
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    await handler([runId, '--format', 'md']);
    expect(out).toContain('FINAL JUDGMENT');
    expect(out).toContain('BBCA');
    expect(out).toContain('Breakdown');
    expect(out).toContain('Financial Health');
  });

  it('export html berisi tag html dan FINAL JUDGMENT', async () => {
    const runId = await createRun();
    const handler = makeExportCommand(ctx());
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    await handler([runId, '--format', 'html']);
    expect(out).toContain('<!doctype html>');
    expect(out).toContain('FINAL JUDGMENT');
  });

  it('export --out menulis file', async () => {
    const runId = await createRun();
    const handler = makeExportCommand(ctx());
    const outPath = join(homeDir, 'export.md');
    await handler([runId, '--format', 'md', '--out', outPath]);
    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, 'utf8');
    expect(content).toContain('FINAL JUDGMENT');
  });

  it('runId tak ada → NOT_FOUND', async () => {
    const handler = makeExportCommand(ctx());
    await expect(handler(['run_unknown'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('format tak dikenal → INVALID_ARG', async () => {
    const runId = await createRun();
    const handler = makeExportCommand(ctx());
    await expect(handler([runId, '--format', 'xml'])).rejects.toMatchObject({ code: 'INVALID_ARG' });
  });
});
