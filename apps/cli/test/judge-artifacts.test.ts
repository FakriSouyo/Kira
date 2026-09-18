import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { loadConfig } from '../src/config';
import { createHarnessSession } from '../src/repl/session';

describe('PR F /judge typed artifacts', () => {
  let dir: string;
  let db: FinharnessDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'finharness-judge-artifacts-'));
    db = openDb({ homeDir: dir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const config = () => loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true });

  it('publishes stable Bull, Bear, and Verdict references from one successful /judge', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBCA']);
    const sessionId = session.conversation.id;
    const execution = (await db.sessions.getSessionArtifacts(sessionId)).executions[0]!;
    const artifacts = await db.artifacts.getByExecution(execution.id);

    const refs = artifacts.map(artifact => ({ kind: artifact.kind, artifactId: artifact.artifactId }));
    expect(refs).toEqual([
      { kind: 'BULL_CASE', artifactId: `artifact_bull_case_${execution.id}` },
      { kind: 'BEAR_CASE', artifactId: `artifact_bear_case_${execution.id}` },
      { kind: 'VERDICT', artifactId: `artifact_verdict_${execution.id}` },
    ]);
    expect(artifacts.every(artifact => artifact.executionId === execution.id && artifact.sessionId === sessionId)).toBe(true);

    const context = await db.workingContext.current(sessionId);
    expect(context?.activeThesisRef).toBeNull();
    expect(context?.activeBullCaseRef).toEqual(refs[0]);
    expect(context?.activeBearCaseRef).toEqual(refs[1]);
    expect(context?.activeVerdictRef).toEqual(refs[2]);
    expect(await db.workingContext.history(sessionId)).toHaveLength(1);
    expect(db.journal.read(sessionId).filter(entry => entry.payload.type === 'session.context.updated')).toHaveLength(1);
    expect((artifacts[2]!.payload as { evidenceIds: string[] }).evidenceIds).toEqual(
      expect.arrayContaining((await db.evidence.getByRun(execution.id)).map(evidence => evidence.id)),
    );
    expect((artifacts[2]!.payload as { judgment: unknown }).judgment).toEqual(
      expect.objectContaining({ score: (await db.judgments.getByRun(execution.id))!.score }),
    );
    await session.close();
  });

  it('creates new execution artifacts while reusing only the run-scoped Evidence rows', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBCA']);
    await session.commands.get('judge')!(['BBCA']);
    const executions = (await db.sessions.getSessionArtifacts(session.conversation.id)).executions;
    const first = await db.artifacts.getByExecution(executions[0]!.id);
    const second = await db.artifacts.getByExecution(executions[1]!.id);

    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    expect(new Set(first.map(artifact => artifact.artifactId).concat(second.map(artifact => artifact.artifactId))).size).toBe(6);
    expect((await db.evidence.getByRun(executions[0]!.id)).length).toBeGreaterThan(0);
    expect((await db.evidence.getByRun(executions[1]!.id)).length).toBeGreaterThan(0);
    expect(second[2]!.payload).not.toBe(first[2]!.payload);
    expect((second[2]!.payload as { evidenceIds: string[] }).evidenceIds).toEqual(
      expect.arrayContaining((await db.evidence.getByRun(executions[1]!.id)).map(evidence => evidence.id)),
    );
    await session.close();
  });

  it('does not reuse prior artifacts as the result of a second /judge', async () => {
    const session = await createHarnessSession(db, loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true }), { write: () => {} });
    await session.commands.get('judge')!(['BBRI']);
    await session.commands.get('judge')!(['BBRI']);

    const trace = await db.sessions.getSessionArtifacts(session.conversation.id);
    expect(trace.executions).toHaveLength(2);
    const artifactRows = db.raw.prepare('SELECT artifact_id, execution_id FROM artifacts ORDER BY execution_id, artifact_id').all() as Array<{ artifact_id: string; execution_id: string }>;
    expect(new Set(artifactRows.map(row => row.execution_id)).size).toBe(2);
    expect(trace.steps.filter(step => step.runId === trace.executions[1]!.id && step.status === 'completed').length).toBeGreaterThan(0);
    await session.close();
  });

  it('does not publish successful artifacts for failed or cancelled /judge', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await expect(session.commands.get('judge')!(['ZZZZ'])).rejects.toThrow();
    const failedSession = await db.sessions.getSessionArtifacts(session.conversation.id);
    expect(await db.artifacts.getByExecution(failedSession.executions[0]!.id)).toEqual([]);

    const controller = new AbortController();
    const analyze = session.context.bull.analyze.bind(session.context.bull);
    vi.spyOn(session.context.bull, 'analyze').mockImplementation(async args => {
      const value = await analyze(args);
      controller.abort();
      return value;
    });
    await expect(session.commands.get('judge')!(['BBRI'], { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    const all = await db.sessions.getSessionArtifacts(session.conversation.id);
    const cancelled = all.executions.find(execution => execution.status === 'cancelled')!;
    expect(await db.artifacts.getByExecution(cancelled.id)).toEqual([]);
    await session.close();
  });
});
