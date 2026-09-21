import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunner } from '@harness/command-core';
import { checkpointKindForNode, createJudgeWorkflow, JUDGE_NODE_IDS } from '@harness/command-judge';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { createExecutionProfile, createWorkflowNodeOutput } from '@harness/session-core';
import { loadConfig } from '../src/config';
import { createHarnessSession } from '../src/repl/session';
import { workflowDependencyFingerprint } from '../src/workflows/judgeCheckpoint';

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

  it('writes one validated PR P checkpoint for every Judge node, including skipped branches', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBCA']);
    const execution = (await db.sessions.getSessionArtifacts(session.conversation.id)).executions[0]!;
    const outputs = await db.workflowNodeOutputs.listNodeOutputsForExecution(execution.id);
    const definition = createJudgeWorkflow();

    expect(outputs.map(output => output.nodeId)).toEqual([...JUDGE_NODE_IDS]);
    expect(outputs.map(output => output.outputKind)).toEqual(JUDGE_NODE_IDS.map(checkpointKindForNode));
    expect(outputs.every(output => output.workflowId === 'judge' && output.workflowVersion === 2)).toBe(true);
    expect(outputs.every(output => output.outputFingerprint.length === 64 && output.dependencyFingerprint.length === 64)).toBe(true);
    expect(outputs.filter(output => output.status === 'skipped').map(output => output.nodeId)).toEqual([
      'conditional-bear-rechallenge', 'conditional-bull-rebuttal', 'resolve-conflicts',
    ]);
    expect(outputs.length).toBe(definition.nodes.length);
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

  it('repairs missing completed-run artifacts on restart without rerunning the workflow', async () => {
    let session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBCA']);
    const sessionId = session.conversation.id;
    const execution = (await db.sessions.getSessionArtifacts(sessionId)).executions[0]!;
    await session.close();
    db.raw.prepare('DELETE FROM artifacts WHERE execution_id = ?').run(execution.id);
    db.raw.close();
    db = openDb({ homeDir: dir });

    const run = vi.spyOn(WorkflowRunner.prototype, 'run');
    session = await createHarnessSession(db, config(), { write: () => {} });
    expect(run).not.toHaveBeenCalled();
    expect(await db.artifacts.getByExecution(execution.id)).toHaveLength(3);
    expect((await db.sessions.getSessionArtifacts(sessionId)).executions).toHaveLength(1);
    await session.close();
  });

  it('repairs a completed pre-R2C2 profile without requiring active capability authority', async () => {
    let session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBCA']);
    const sessionId = session.conversation.id;
    const execution = (await db.sessions.getSessionArtifacts(sessionId)).executions[0]!;
    const profile = await db.executionProfiles.getByExecutionId(execution.id);
    expect(profile).toBeTruthy();
    const payload = profile!.payload as Record<string, unknown>;
    const { capabilityPlan: _capabilityPlan, capabilityPlanFingerprint: _capabilityPlanFingerprint, ...legacyPayload } = payload;
    const legacyProfile = createExecutionProfile({
      executionId: profile!.executionId,
      workflowId: profile!.workflowId,
      workflowVersion: profile!.workflowVersion,
      graphFingerprint: profile!.graphFingerprint,
      command: profile!.command,
      ticker: profile!.ticker,
      payload: legacyPayload as never,
      createdAt: profile!.createdAt,
    });
    db.raw.prepare('UPDATE execution_profiles SET payload_json = ?, fingerprint = ? WHERE execution_id = ?')
      .run(JSON.stringify(legacyProfile.payload), legacyProfile.fingerprint, execution.id);
    await session.close();
    db.raw.prepare('DELETE FROM artifacts WHERE execution_id = ?').run(execution.id);
    db.raw.close();
    db = openDb({ homeDir: dir });

    const outputs = await db.workflowNodeOutputs.listNodeOutputsForExecution(execution.id);
    const fingerprints = new Map<string, string>();
    for (const node of createJudgeWorkflow().nodes) {
      const output = outputs.find(candidate => candidate.nodeId === node.id);
      if (!output) continue;
      const dependencyFingerprint = workflowDependencyFingerprint(node, fingerprints, legacyProfile.fingerprint);
      const rewritten = createWorkflowNodeOutput({ ...output, dependencyFingerprint });
      db.raw.prepare('UPDATE workflow_node_outputs SET dependency_fingerprint = ?, output_fingerprint = ? WHERE output_id = ?')
        .run(dependencyFingerprint, rewritten.outputFingerprint, output.outputId);
      fingerprints.set(node.id, rewritten.outputFingerprint);
    }
    const run = vi.spyOn(WorkflowRunner.prototype, 'run');
    session = await createHarnessSession(db, config(), { write: () => {} });
    expect(run).not.toHaveBeenCalled();
    expect(await db.artifacts.getByExecution(execution.id)).toHaveLength(3);
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
