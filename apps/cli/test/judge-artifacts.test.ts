import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunner } from '@harness/command-core';
import { checkpointKindForNode, createJudgeWorkflow, JUDGE_NODE_IDS, JUDGE_RELEASE_CONTRACT_FINGERPRINT } from '@harness/command-judge';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { claimGraphFingerprint, createClaimGraphReleaseReceipt } from '@harness/execution';
import { createExecutionProfile, createWorkflowNodeOutput } from '@harness/session-core';
import { loadConfig } from '../src/config';
import { createHarnessSession } from '../src/repl/session';
import { judgeWorkflow } from '../src/workflows/judgeWorkflow';
import { repairCompletedJudgeReleases, workflowDependencyFingerprint } from '../src/workflows/judgeCheckpoint';

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

  async function expectT5ReleaseGateFailure(mutateCanonicalState: (executionId: string) => void): Promise<void> {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    const providerCalls = [
      'getCompanyReport', 'getQuarterlyFinancials', 'getDailyTransaction',
      'getForeignFlow', 'getNews', 'getFilings', 'getSentiment',
    ].map(method => vi.spyOn(session.context.financialData, method));
    const modelCalls = [
      vi.spyOn(session.context.bull, 'analyze'),
      vi.spyOn(session.context.bear, 'challenge'),
      vi.spyOn(session.context.judge, 'evaluate'),
    ];
    const dependencyCalls = [...providerCalls, ...modelCalls];
    let countsAfterWorkflow: number[] = [];
    const originalRun = WorkflowRunner.prototype.run;
    const runner = vi.spyOn(WorkflowRunner.prototype, 'run');
    runner.mockImplementation(async function (this: WorkflowRunner, ...args: unknown[]) {
      const outputs = await originalRun.apply(this, args as never) as Record<string, unknown>;
      countsAfterWorkflow = dependencyCalls.map(call => call.mock.calls.length);
      const row = db.raw.prepare('SELECT id FROM executions ORDER BY rowid DESC LIMIT 1').get() as { id: string };
      mutateCanonicalState(row.id);
      return outputs;
    } as never);

    await expect(session.commands.get('judge')!(['BBCA'])).rejects.toThrow();
    const execution = (await db.sessions.getSessionArtifacts(session.conversation.id)).executions[0]!;
    expect(execution.status).toBe('failed');
    expect(await db.artifacts.getByExecution(execution.id)).toEqual([]);
    expect(await db.claimGraphReleases.getByExecution(execution.id)).toBeNull();
    expect(dependencyCalls.map(call => call.mock.calls.length)).toEqual(countsAfterWorkflow);
    await session.close();
  }

  it('publishes stable Bull, Bear, and Verdict references from one successful /judge', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBCA']);
    const sessionId = session.conversation.id;
    const execution = (await db.sessions.getSessionArtifacts(sessionId)).executions[0]!;
    const artifacts = await db.artifacts.getByExecution(execution.id);
    const profile = await db.executionProfiles.getByExecutionId(execution.id);
    const graph = await db.claimGraph.getByExecution(execution.id);
    const receipt = await db.claimGraphReleases.getByExecution(execution.id);

    const refs = artifacts.map(artifact => ({ kind: artifact.kind, artifactId: artifact.artifactId }));
    expect(refs).toEqual([
      { kind: 'BULL_CASE', artifactId: `artifact_bull_case_${execution.id}` },
      { kind: 'BEAR_CASE', artifactId: `artifact_bear_case_${execution.id}` },
      { kind: 'VERDICT', artifactId: `artifact_verdict_${execution.id}` },
    ]);
    expect(artifacts.every(artifact => artifact.executionId === execution.id && artifact.sessionId === sessionId)).toBe(true);
    expect(execution.status).toBe('completed');
    expect(profile?.payload.releaseContractFingerprint).toBe(JUDGE_RELEASE_CONTRACT_FINGERPRINT);
    expect(receipt).toMatchObject({
      executionId: execution.id,
      sessionId: execution.sessionId,
      turnId: execution.turnId,
      ticker: execution.ticker,
      releaseContractFingerprint: profile?.payload.releaseContractFingerprint,
      claimGraphFingerprint: claimGraphFingerprint(graph),
    });
    expect(receipt?.artifactProjections.map(projection => projection.kind)).toEqual(['BULL_CASE', 'BEAR_CASE', 'VERDICT']);
    expect(receipt?.artifactProjections[2]?.nodes).toEqual(graph.nodes);
    expect(receipt?.artifactProjections[2]?.edges).toEqual(graph.edges);
    expect(await db.claimGraphReleases.save(receipt!)).toEqual(receipt);

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
    const durableCounterpoints = await db.counterpoints.getByRun(execution.id);
    expect(new Set(durableCounterpoints.map(point => point.sourceNodeId))).toEqual(new Set(['round-1-bear-challenge']));
    const bearCounterpoints = (artifacts[1]!.payload as { counterpoints: Array<Record<string, unknown>> }).counterpoints;
    const roundOneCounterpoints = durableCounterpoints.filter(point => point.sourceNodeId === 'round-1-bear-challenge');
    expect(bearCounterpoints.map(point => point.counterpointId).sort()).toEqual(roundOneCounterpoints.map(point => point.counterpointId).sort());
    expect(bearCounterpoints.every(point => point.sourceNodeId === 'round-1-bear-challenge')).toBe(true);
    expect(bearCounterpoints.every(point => Array.isArray(point.evidenceIds) && Array.isArray(point.evidenceLinks)
      && point.policyId === 'counterpoint-policy-v1')).toBe(true);
    const bullPayload = artifacts[0]!.payload as {
      thesis: { claims: Array<{ claimId: string }> };
      rebuttal: { claims: Array<{ claimId: string }> };
    };
    expect(receipt?.artifactProjections[0]?.nodes.map(node => node.kind === 'claim' ? node.claimId : '')).toEqual(
      [...bullPayload.thesis.claims, ...bullPayload.rebuttal.claims].map(claim => claim.claimId).sort(),
    );
    expect(receipt?.artifactProjections[1]?.edges.map(edge => [edge.from.counterpointId, edge.to.claimId]).sort()).toEqual(
      roundOneCounterpoints.map(point => [point.counterpointId, point.targetClaimId]).sort(),
    );
    await session.close();
  });

  it('keeps conditional graph rows only in the full VERDICT projection', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    const sessionId = session.conversation.id;
    const turn = await db.sessions.createTurn({ sessionId, input: '/judge BBCA --conditional', command: 'judge' });
    let calls = 0;
    const evaluate = session.context.judge.evaluate.bind(session.context.judge);
    session.context.judge.evaluate = async params => {
      calls += 1;
      return {
        value: {
          ticker: 'BBCA',
          score: 50,
          stance: 'neutral' as const,
          confidence: 'moderate' as const,
          breakdown: { financialHealth: 50, growth: 50, valuation: 50, marketMomentum: null, risk: null },
          summary: `Neutral release fixture ${calls}`,
        },
        subagent: 'judge',
        skills: [{ name: 'evidence-weighing', contentHash: 'test-hash' }],
      };
    };
    const result = await judgeWorkflow(session.context, 'BBCA', () => {}, () => {}, {
      conditional: true,
      lifecycle: { sessionId, turnId: turn.id },
    });
    session.context.judge.evaluate = evaluate;
    const receipt = (await db.claimGraphReleases.getByExecution(result.run.id))!;
    const graph = await db.claimGraph.getByExecution(result.run.id);
    const counterpoints = await db.counterpoints.getByRun(result.run.id);
    const artifacts = await db.artifacts.getByExecution(result.run.id);
    const bullPayload = artifacts[0]!.payload as {
      thesis: { claims: Array<{ claimId: string }> };
      rebuttal: { claims: Array<{ claimId: string }> };
    };
    const bearPayload = artifacts[1]!.payload as { counterpoints: Array<{ counterpointId: string }> };

    expect(calls).toBe(2);
    expect(counterpoints.some(point => point.sourceNodeId === 'conditional-bear-rechallenge')).toBe(true);
    expect(receipt.artifactProjections[0]!.nodes.map(node => node.kind === 'claim' ? node.claimId : '')).toEqual(
      [...bullPayload.thesis.claims, ...bullPayload.rebuttal.claims].map(claim => claim.claimId).sort(),
    );
    expect(receipt.artifactProjections[1]!.nodes.filter(node => node.kind === 'counterpoint').map(node => node.counterpointId)).toEqual(
      bearPayload.counterpoints.map(point => point.counterpointId),
    );
    expect(receipt.artifactProjections[1]!.nodes.some(node => node.kind === 'counterpoint' && node.counterpointId.includes('conditional'))).toBe(false);
    expect(receipt.artifactProjections[2]!.nodes).toEqual(graph.nodes);
    expect(receipt.artifactProjections[2]!.edges).toEqual(graph.edges);
    await session.close();
  });

  it('keeps release receipts immutable and fails closed on lifecycle or fingerprint corruption', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBCA']);
    const execution = (await db.sessions.getSessionArtifacts(session.conversation.id)).executions[0]!;
    const receipt = (await db.claimGraphReleases.getByExecution(execution.id))!;
    const { receiptId: _receiptId, schemaVersion: _schemaVersion, fingerprint: _fingerprint, ...input } = receipt;

    const conflictingReceipt = createClaimGraphReleaseReceipt({
      ...input,
      releaseContractFingerprint: 'f'.repeat(64),
    });
    await expect(db.claimGraphReleases.save(conflictingReceipt)).rejects.toThrow(/immutable|does not match/);
    await expect(db.claimGraphReleases.save(createClaimGraphReleaseReceipt({
      ...input,
      sessionId: 'other-session',
    }))).rejects.toThrow(/lifecycle identity/);

    db.raw.prepare('DELETE FROM artifacts WHERE artifact_id = ?').run(`artifact_verdict_${execution.id}`);
    await expect(db.claimGraphReleases.getByExecution(execution.id)).rejects.toThrow(/missing Artifact/);
    await expect(repairCompletedJudgeReleases({ db, sessionId: session.conversation.id })).resolves.toBe(1);
    expect(await db.artifacts.getByExecution(execution.id)).toHaveLength(3);
    expect(await db.claimGraphReleases.getByExecution(execution.id)).not.toBeNull();

    db.raw.prepare('UPDATE claim_graph_release_receipts SET payload_json = ?, fingerprint = ? WHERE execution_id = ?')
      .run(JSON.stringify(conflictingReceipt), conflictingReceipt.fingerprint, execution.id);
    await expect(repairCompletedJudgeReleases({ db, sessionId: session.conversation.id })).rejects.toThrow(/immutable and conflicts/);

    db.raw.prepare('UPDATE claim_graph_release_receipts SET fingerprint = ? WHERE execution_id = ?')
      .run('0'.repeat(64), execution.id);
    await expect(repairCompletedJudgeReleases({ db, sessionId: session.conversation.id })).rejects.toThrow(/fingerprint validation/);
    await session.close();
  });

  it('fails closed when a completed T5 artifact conflicts with its immutable checkpoint projection', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBCA']);
    const execution = (await db.sessions.getSessionArtifacts(session.conversation.id)).executions[0]!;
    const artifactId = `artifact_bull_case_${execution.id}`;
    const row = db.raw.prepare('SELECT payload_json FROM artifacts WHERE artifact_id = ?').get(artifactId) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { thesis: { reasoning: string } };
    payload.thesis.reasoning = 'A valid but conflicting Bull thesis artifact was substituted.';
    db.raw.prepare('UPDATE artifacts SET payload_json = ? WHERE artifact_id = ?').run(JSON.stringify(payload), artifactId);

    await expect(repairCompletedJudgeReleases({ db, sessionId: session.conversation.id })).rejects.toThrow(/immutable write conflict/);
    await session.close();
  });

  it.each([
    ['a missing canonical Claim', (id: string) => db.raw.prepare('DELETE FROM claims WHERE run_id = ? AND rowid = (SELECT MIN(rowid) FROM claims WHERE run_id = ?)').run(id, id)],
    ['an unexpected canonical Claim', (id: string) => db.raw.prepare(`INSERT INTO claims
      SELECT lower(hex(randomblob(16))), run_id, message_id, claim_id || ':unexpected', statement, confidence, reasoning,
        evidence_ids, cited_figures, single_metric, evidence_links, policy_id, policy_fingerprint, created_at
      FROM claims WHERE run_id = ? LIMIT 1`).run(id)],
    ['Claim checkpoint semantic drift', (id: string) => db.raw.prepare('UPDATE claims SET statement = ? WHERE run_id = ? AND rowid = (SELECT MIN(rowid) FROM claims WHERE run_id = ?)').run('A conflicting stored statement.', id, id)],
    ['Claim Policy drift', (id: string) => db.raw.prepare('UPDATE claims SET policy_fingerprint = ? WHERE run_id = ?').run('0'.repeat(64), id)],
    ['Claim Policy identity drift', (id: string) => db.raw.prepare('UPDATE claims SET policy_id = ? WHERE run_id = ?').run('claim-policy-legacy', id)],
    ['a missing canonical Counterpoint', (id: string) => db.raw.prepare('DELETE FROM counterpoints WHERE run_id = ?').run(id)],
    ['an unexpected canonical Counterpoint', (id: string) => db.raw.prepare(`INSERT INTO counterpoints
      SELECT lower(hex(randomblob(16))), run_id, message_id, 'counterpoint:round-1-bear-challenge:99', source_node_id,
        target_claim_id, argument, strength, evidence_ids, cited_figures, evidence_links, policy_id, policy_fingerprint, created_at
      FROM counterpoints WHERE run_id = ? LIMIT 1`).run(id)],
    ['Counterpoint checkpoint semantic drift', (id: string) => db.raw.prepare('UPDATE counterpoints SET argument = ? WHERE run_id = ?').run('A conflicting stored argument.', id)],
    ['Counterpoint Policy drift', (id: string) => db.raw.prepare('UPDATE counterpoints SET policy_id = ? WHERE run_id = ?').run('counterpoint-policy-legacy', id)],
    ['Counterpoint Policy fingerprint drift', (id: string) => db.raw.prepare('UPDATE counterpoints SET policy_fingerprint = ? WHERE run_id = ?').run('0'.repeat(64), id)],
    ['a Counterpoint target outside the Claim set', (id: string) => db.raw.prepare('UPDATE counterpoints SET target_claim_id = ? WHERE run_id = ?').run('absent-claim', id)],
  ])('fails before completion and publication for %s', async (_label, mutate) => {
    await expectT5ReleaseGateFailure(mutate);
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

  it('repairs a missing artifact while retaining and validating the completed T5 receipt', async () => {
    let session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBCA']);
    const sessionId = session.conversation.id;
    const execution = (await db.sessions.getSessionArtifacts(sessionId)).executions[0]!;
    await session.close();
    db.raw.prepare('DELETE FROM artifacts WHERE execution_id = ? AND kind = ?').run(execution.id, 'BEAR_CASE');
    db.raw.close();
    db = openDb({ homeDir: dir });

    const run = vi.spyOn(WorkflowRunner.prototype, 'run');
    session = await createHarnessSession(db, config(), { write: () => {} });
    expect(run).not.toHaveBeenCalled();
    expect(await db.artifacts.getByExecution(execution.id)).toHaveLength(3);
    expect(await db.claimGraphReleases.getByExecution(execution.id)).not.toBeNull();
    expect((await db.sessions.getSessionArtifacts(sessionId)).executions).toHaveLength(1);
    await session.close();
  });

  it('repairs three existing T5 artifacts when their release receipt is missing, without running Judge', async () => {
    let session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBCA']);
    const sessionId = session.conversation.id;
    const execution = (await db.sessions.getSessionArtifacts(sessionId)).executions[0]!;
    await session.close();
    db.raw.prepare('DELETE FROM claim_graph_release_receipts WHERE execution_id = ?').run(execution.id);
    db.raw.close();
    db = openDb({ homeDir: dir });

    const run = vi.spyOn(WorkflowRunner.prototype, 'run');
    session = await createHarnessSession(db, config(), { write: () => {} });
    expect(run).not.toHaveBeenCalled();
    expect(await db.artifacts.getByExecution(execution.id)).toHaveLength(3);
    expect(await db.claimGraphReleases.getByExecution(execution.id)).not.toBeNull();
    await session.close();
  });

  it('repairs a completed T5 execution with no artifacts or receipt on startup', async () => {
    let session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBCA']);
    const sessionId = session.conversation.id;
    const execution = (await db.sessions.getSessionArtifacts(sessionId)).executions[0]!;
    await session.close();
    db.raw.prepare('DELETE FROM artifacts WHERE execution_id = ?').run(execution.id);
    db.raw.prepare('DELETE FROM claim_graph_release_receipts WHERE execution_id = ?').run(execution.id);
    db.raw.close();
    db = openDb({ homeDir: dir });

    const run = vi.spyOn(WorkflowRunner.prototype, 'run');
    session = await createHarnessSession(db, config(), { write: () => {} });
    expect(run).not.toHaveBeenCalled();
    expect(await db.artifacts.getByExecution(execution.id)).toHaveLength(3);
    expect(await db.claimGraphReleases.getByExecution(execution.id)).not.toBeNull();
    await session.close();
  });

  it('repairs a completed pre-T5 profile without fabricating a release receipt', async () => {
    let session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBCA']);
    const sessionId = session.conversation.id;
    const execution = (await db.sessions.getSessionArtifacts(sessionId)).executions[0]!;
    const profile = await db.executionProfiles.getByExecutionId(execution.id);
    expect(profile).toBeTruthy();
    const payload = profile!.payload as Record<string, unknown>;
      const {
        capabilityPlan: _capabilityPlan,
        capabilityPlanFingerprint: _capabilityPlanFingerprint,
        releaseContract: _releaseContract,
        releaseContractFingerprint: _releaseContractFingerprint,
        ...legacyPayload
      } = payload;
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
    db.raw.prepare('DELETE FROM claim_graph_release_receipts WHERE execution_id = ?').run(execution.id);
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
    expect(await db.claimGraphReleases.getByExecution(execution.id)).toBeNull();
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
