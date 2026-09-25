import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunner } from '@harness/command-core';
import {
  createJudgeCommandContext,
  createJudgeExecutionProfile,
  createJudgeWorkflow,
  judgeWorkflowGraphFingerprint,
  type JudgeNodeId,
} from '@harness/command-judge';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { storedClaimToClaim } from '@harness/execution';
import { type FinancialDataProvider } from '@harness/financial-data';
import { createExecutionProfile, createWorkflowNodeOutput } from '@harness/session-core';
import { WorkflowTraceRecorder } from '@harness/engine';
import { buildContext } from '../src/context';
import { loadConfig, type FinharnessConfig } from '../src/config';
import { createHarnessSession } from '../src/repl/session';
import { createJudgeNodeExecutors } from '@harness/engine';
import {
  decodeJudgeCheckpoint,
  JudgeCheckpointWriter,
  planJudgeResume,
  repairJudgeProjections,
} from '../src/workflows/judgeCheckpoint';

type Fixture = {
  dir: string;
  db: FinharnessDatabase;
  config: FinharnessConfig;
  sessionId: string;
  turnId: string;
  executionId: string;
};

const reopenedDatabases: FinharnessDatabase[] = [];
let db: FinharnessDatabase;

const PROVIDER_METHODS: Array<keyof FinancialDataProvider> = [
  'getCompanyReport', 'getQuarterlyFinancials', 'getDailyTransaction',
  'getForeignFlow', 'getNews', 'getFilings', 'getSentiment',
];

const MODEL_METHODS = ['analyze', 'challenge', 'rebuttal', 'evaluate'] as const;

function createConfig(dir: string, overrides: Partial<FinharnessConfig['llm']['agent']> = {}): FinharnessConfig {
  const config = loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true });
  config.llm.agent = { ...config.llm.agent, ...overrides };
  return config;
}

async function createFixture(
  db: FinharnessDatabase,
  config: FinharnessConfig,
  options: { suffix?: string; reasoningMode?: 'usual' | 'reasoning'; conditional?: boolean; runtimePlan?: boolean } = {},
): Promise<Fixture> {
  const suffix = options.suffix ?? 'acceptance';
  const sessionId = `conversation_${suffix}`;
  const turnId = `turn_${suffix}`;
  const executionId = `run_${suffix}`;
  const session = await db.sessions.createSession({
    sessionId, title: `Acceptance ${suffix}`, provider: config.llm.agent.provider,
    model: config.llm.agent.model, reasoningMode: options.reasoningMode ?? 'usual',
  });
  const turn = await db.sessions.createTurn({
    turnId, sessionId: session.id, input: '/judge BBCA', command: 'judge',
  });
  const execution = await db.sessions.createExecution({
    executionId, sessionId: session.id, turnId: turn.id, ticker: 'BBCA', command: 'judge',
  });
  const composition = buildContext(db, config, { sessionId });
  const runtimePlan = options.runtimePlan ? composition.runtimePlan : undefined;
  const profile = createJudgeExecutionProfile({
    executionId: execution.id, ticker: 'BBCA',
    reasoningMode: options.reasoningMode ?? 'usual',
    conditional: options.conditional ?? false,
    researchers: config.researchers,
    provider: config.llm.agent.providerId ?? config.llm.agent.provider, model: config.llm.agent.model,
    capabilityPlan: composition.judgeCapabilityPlan,
    ...(runtimePlan ? { runtimePlan } : {}),
    createdAt: execution.createdAt,
  });
  await db.executionProfiles.save(profile);

  db.journal.append(session.id, {
    type: 'message.added', id: `message_${suffix}`, role: 'user', content: '/judge BBCA', state: 'completed',
    turnId: turn.id, executionId: execution.id, correlationId: turn.id,
  });
  db.journal.append(session.id, {
    type: 'turn.started', id: turn.id, turnId: turn.id, correlationId: turn.id,
  });
  db.journal.append(session.id, {
    type: 'run.started', id: execution.id, subject: 'BBCA', command: 'judge',
    turnId: turn.id, executionId: execution.id, correlationId: turn.id,
  });

  return { dir: config.homeDir, db, config, sessionId, turnId, executionId };
}

async function runPrefix(fixture: Fixture, boundary: JudgeNodeId): Promise<void> {
  const definition = createJudgeWorkflow();
  const end = definition.nodes.findIndex(node => node.id === boundary);
  if (end < 0) throw new Error(`Unknown boundary ${boundary}`);
  const prefix = { ...definition, nodes: definition.nodes.slice(0, end + 1) };
  const execution = (await fixture.db.sessions.getSessionArtifacts(fixture.sessionId)).executions[0]!;
  const profile = await fixture.db.executionProfiles.getByExecutionId(execution.id);
  if (!profile) throw new Error(`Profile missing for ${execution.id}`);
  const context = buildContext(fixture.db, fixture.config, { sessionId: fixture.sessionId });
  const recorder = new WorkflowTraceRecorder({ runId: execution.id, definition, store: fixture.db.sessions });
  const writer = new JudgeCheckpointWriter({ db: fixture.db, execution, profile, definition });
  const decision = {};
  const payload = profile.payload as { reasoningMode: 'usual' | 'reasoning'; conditional: boolean; researchers: { market: boolean; news: boolean } };
  const executors = createJudgeNodeExecutors({
    deps: {
      capabilityGateway: context.capabilityGateway,
      bull: context.bull,
      bear: context.bear,
      judge: context.judge,
      validator: context.validator,
      researchers: payload.researchers,
      evidence: fixture.db.evidence,
      financialSnapshots: fixture.db.financialSnapshots,
      conversation: fixture.db.conversation,
      claims: fixture.db.claims,
      counterpoints: fixture.db.counterpoints,
      judgments: fixture.db.judgments,
    },
    ticker: 'BBCA', runId: execution.id, events: () => {}, progress: () => {}, decision,
    reasoning: payload.reasoningMode === 'reasoning', conditional: payload.conditional,
    executionStartedAt: execution.createdAt,
    lifecycle: { sessionId: fixture.sessionId, turnId: fixture.turnId },
    trace: { recordSubagentResult: (nodeId, result) => recorder.recordSubagentResult(nodeId, result) },
    checkpoint: (nodeId, value) => writer.completedValue(nodeId, value),
  });
  await new WorkflowRunner({
    onEvent: event => recorder.handle(event),
    onNodeCompleted: (node, value, inputs) => writer.completed(node, value, inputs),
    onNodeSkipped: node => writer.skipped(node),
    onNodeFailed: (node, error) => writer.optionalFailure(node, error),
  }).run(prefix, createJudgeCommandContext({
    reasoningMode: payload.reasoningMode, conditional: payload.conditional,
    researchers: payload.researchers, executors, decision,
  }));
  await fixture.db.sessions.interruptExecution(execution.id, `crashed after ${boundary}`);
}

function reopen(fixture: Fixture): void {
  fixture.db.raw.close();
  fixture.db = openDb({ homeDir: fixture.dir });
  reopenedDatabases.push(fixture.db);
}

async function openRuntime(fixture: Fixture, config = fixture.config) {
  db = fixture.db;
  const runtime = await createHarnessSession(fixture.db, config, { write: () => {} });
  if (runtime.conversation.id !== fixture.sessionId) await runtime.openConversation(fixture.sessionId);
  return runtime;
}

function providerSpies(provider: FinancialDataProvider) {
  return PROVIDER_METHODS.map(method => vi.spyOn(provider, method));
}

function modelSpies(runtime: Awaited<ReturnType<typeof createHarnessSession>>) {
  return MODEL_METHODS.map(method => vi.spyOn(runtime.context[method === 'evaluate' ? 'judge' : method === 'challenge' ? 'bear' : 'bull'], method));
}

async function sessionRows(fixture: Fixture) {
  return fixture.db.sessions.getSessionArtifacts(fixture.sessionId);
}

describe('PR P final acceptance hardening', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'finharness-pr-p-acceptance-'));
    db = openDb({ homeDir: dir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const candidate of [db, ...reopenedDatabases]) {
      try { candidate.raw.close(); } catch { /* already closed by a restart fixture */ }
    }
    reopenedDatabases.splice(0);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may release WAL handles shortly after close */ }
  });

  it('proves successful restart resume keeps one Turn, one Execution, and one pair of start events', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'journal' });
    await runPrefix(fixture, 'round-1-bull-thesis');
    const before = await sessionRows(fixture);
    reopen(fixture);
    const runtime = await openRuntime(fixture);
    const providers = providerSpies(runtime.context.financialData);
    const models = modelSpies(runtime);
    await runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` });
    await runtime.close();

    const after = await sessionRows(fixture);
    const starts = fixture.db.journal.read(fixture.sessionId).filter(entry =>
      entry.payload.type === 'turn.started' || entry.payload.type === 'run.started');
    expect(starts.map(entry => entry.payload.type)).toEqual(['turn.started', 'run.started']);
    expect(after.turns).toHaveLength(before.turns.length);
    expect(after.executions).toHaveLength(1);
    expect(after.executions[0]).toMatchObject({
      id: fixture.executionId, turnId: fixture.turnId, attempt: 1, status: 'completed', resumeGeneration: 1,
    });
    expect(after.turns[0]).toMatchObject({ id: fixture.turnId, status: 'completed' });
    expect(providers.every(call => call.mock.calls.length === 0)).toBe(true);
  });

  it('rejects provider and model drift before acquisition, then resumes after restoring the profile identity', async () => {
    const original = createConfig(dir, { provider: 'openai', model: 'model-a' });
    const fixture = await createFixture(db, original, { suffix: 'drift' });
    await runPrefix(fixture, 'collect-sources');
    reopen(fixture);
    const drifted = createConfig(dir, { provider: 'anthropic', model: 'model-b' });
    const driftRuntime = await openRuntime(fixture, drifted);
    const driftProviders = providerSpies(driftRuntime.context.financialData);
    const driftModels = modelSpies(driftRuntime);
    await expect(driftRuntime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` }))
      .rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
    await driftRuntime.close();
    expect((await sessionRows(fixture)).executions[0]).toMatchObject({ status: 'interrupted', resumeGeneration: 0 });
    expect(driftProviders.every(call => call.mock.calls.length === 0)).toBe(true);
    expect(driftModels.every(call => call.mock.calls.length === 0)).toBe(true);

    reopen(fixture);
    const compatible = await openRuntime(fixture, original);
    await compatible.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` });
    await compatible.close();
    expect((await sessionRows(fixture)).executions[0]).toMatchObject({ status: 'completed', resumeGeneration: 1 });
  });

  it('rejects a switched Session model before acquisition and resumes the same Execution after restoring A', async () => {
    const config = createConfig(dir, { model: 'model-a' });
    const fixture = await createFixture(db, config, { suffix: 'q2_switch', runtimePlan: true });
    await runPrefix(fixture, 'collect-sources');

    const runtime = await openRuntime(fixture, config);
    await runtime.setModel('model-b');
    const providers = providerSpies(runtime.context.financialData);
    const models = modelSpies(runtime);

    await expect(runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` }))
      .rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
    const rejected = (await sessionRows(fixture)).executions;
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ id: fixture.executionId, turnId: fixture.turnId, status: 'interrupted', resumeGeneration: 0 });
    expect(providers.every(call => call.mock.calls.length === 0)).toBe(true);
    expect(models.every(call => call.mock.calls.length === 0)).toBe(true);

    await runtime.setModel('model-a');
    await runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` });
    const resumed = (await sessionRows(fixture)).executions;
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ id: fixture.executionId, turnId: fixture.turnId, status: 'completed', resumeGeneration: 1 });
    await runtime.close();
  }, 30000);

  it('rejects an explicit resume from the wrong Session without creating a Turn', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'wrong_session_a' });
    await runPrefix(fixture, 'collect-sources');
    const sessionB = await db.sessions.createSession({
      sessionId: 'conversation_wrong_session_b', title: 'Other session', provider: config.llm.agent.provider,
      model: config.llm.agent.model, reasoningMode: 'usual',
    });
    db.journal.append(sessionB.id, { type: 'message.added', id: 'message_wrong_session_b', role: 'user', content: 'hello', state: 'completed' });
    const runtime = await openRuntime(fixture);
    await runtime.openConversation(sessionB.id);
    const providers = providerSpies(runtime.context.financialData);
    const models = modelSpies(runtime);
    await expect(runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` }))
      .rejects.toMatchObject({ code: 'RESUME_NOT_FOUND' });
    await runtime.close();
    expect((await sessionRows(fixture)).executions[0]).toMatchObject({ status: 'interrupted', resumeGeneration: 0 });
    expect((await db.sessions.getSessionArtifacts(sessionB.id)).turns).toHaveLength(0);
    expect(providers.every(call => call.mock.calls.length === 0)).toBe(true);
    expect(models.every(call => call.mock.calls.length === 0)).toBe(true);
  });

  it('/continue rejects none and ambiguity, and resumes exactly the one candidate', async () => {
    const config = createConfig(dir);
    const none = await createFixture(db, config, { suffix: 'continue_none' });
    await db.sessions.settleExecution(none.executionId, 'failed', { error: 'no candidate for /continue' });
    await db.sessions.settleTurn(none.turnId, 'failed');
    const runtime = await openRuntime(none);
    await expect(runtime.commands.get('continue')!([], { input: '/continue' })).rejects.toMatchObject({ code: 'RESUME_NOT_FOUND' });
    await runtime.close();

    const one = await createFixture(db, config, { suffix: 'continue_one' });
    await runPrefix(one, 'collect-sources');
    const oneRuntime = await openRuntime(one);
    const oneModels = modelSpies(oneRuntime);
    await oneRuntime.commands.get('continue')!([], { input: '/continue' });
    await oneRuntime.close();
    expect((await sessionRows(one)).executions[0]).toMatchObject({ id: one.executionId, status: 'completed', resumeGeneration: 1 });

    const ambiguous = await createFixture(db, config, { suffix: 'continue_many_a' });
    await runPrefix(ambiguous, 'collect-sources');
    const secondTurn = await db.sessions.createTurn({ sessionId: ambiguous.sessionId, turnId: 'turn_continue_many_b', input: '/judge BBCA', command: 'judge' });
    const secondExecution = await db.sessions.createExecution({ executionId: 'run_continue_many_b', sessionId: ambiguous.sessionId, turnId: secondTurn.id, ticker: 'BBCA', command: 'judge' });
    const secondProfile = createJudgeExecutionProfile({
      executionId: secondExecution.id, ticker: 'BBCA', reasoningMode: 'usual', conditional: false,
      researchers: config.researchers, provider: config.llm.agent.provider, model: config.llm.agent.model,
      capabilityPlan: buildContext(db, config, { sessionId: ambiguous.sessionId }).judgeCapabilityPlan, createdAt: secondExecution.createdAt,
    });
    await db.executionProfiles.save(secondProfile);
    await db.sessions.interruptExecution(secondExecution.id, 'second interruption');
    const ambiguousRuntime = await openRuntime(ambiguous);
    await expect(ambiguousRuntime.commands.get('continue')!([], { input: '/continue' }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS_RESUME', suggestion: expect.stringContaining(secondExecution.id) });
    await ambiguousRuntime.close();
    expect((await sessionRows(ambiguous)).executions.every(execution => execution.status === 'interrupted' && execution.resumeGeneration === 0)).toBe(true);
  });

  it.each([
    ['round-1-bear-challenge', 'Bear restore'],
    ['round-2-bull-rebuttal', 'Rebuttal restore'],
    ['evaluate-arguments', 'Judge restore'],
  ] as const)('%s restores exact semantic output without specialist invocation (%s)', async (boundary) => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: boundary.replaceAll('-', '_') });
    await runPrefix(fixture, boundary);
    const beforeOutputs = await fixture.db.workflowNodeOutputs.listNodeOutputsForExecution(fixture.executionId);
    const expected = beforeOutputs.find(output => output.nodeId === boundary)!;
    const beforeSnapshots = fixture.db.raw.prepare('SELECT COUNT(*) AS count FROM context_snapshots WHERE session_id = ? AND turn_id = ?').get(fixture.sessionId, fixture.turnId) as { count: number };
    const beforeCalls = fixture.db.raw.prepare('SELECT id, attempt, step_id FROM model_calls WHERE run_id = ? ORDER BY id').all(fixture.executionId) as Array<{ id: string; attempt: number; step_id: string }>;
    reopen(fixture);
    const runtime = await openRuntime(fixture);
    const models = modelSpies(runtime);
    const bullAnalyze = models.find(spy => spy.getMockName() === 'analyze')!;
    const bearChallenge = models.find(spy => spy.getMockName() === 'challenge')!;
    const bullRebuttal = models.find(spy => spy.getMockName() === 'rebuttal')!;
    const judgeEvaluate = models.find(spy => spy.getMockName() === 'evaluate')!;
    await runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` });
    await runtime.close();

    const afterOutput = await fixture.db.workflowNodeOutputs.getNodeOutput(fixture.executionId, boundary);
    expect(afterOutput?.payload).toEqual(expected.payload);
    expect(afterOutput?.outputFingerprint).toBe(expected.outputFingerprint);
    expect(afterOutput?.completionGeneration).toBe(expected.completionGeneration);
    const afterSnapshots = fixture.db.raw.prepare('SELECT COUNT(*) AS count FROM context_snapshots WHERE session_id = ? AND turn_id = ?').get(fixture.sessionId, fixture.turnId) as { count: number };
    expect(afterSnapshots.count).toBeGreaterThanOrEqual(beforeSnapshots.count);
    const restoredNodes = boundary === 'round-1-bear-challenge'
      ? ['round-1-bull-thesis', 'round-1-bear-challenge']
      : boundary === 'round-2-bull-rebuttal'
        ? ['round-1-bull-thesis', 'round-1-bear-challenge', 'round-2-bull-rebuttal']
        : ['round-1-bull-thesis', 'round-1-bear-challenge', 'round-2-bull-rebuttal', 'evaluate-arguments'];
    const restoredSteps = new Set(restoredNodes.map(node => `step_${fixture.executionId}_${node}`));
    const afterCalls = fixture.db.raw.prepare('SELECT id, attempt, step_id FROM model_calls WHERE run_id = ? ORDER BY id').all(fixture.executionId) as Array<{ id: string; attempt: number; step_id: string }>;
    expect(afterCalls.filter(call => restoredSteps.has(call.step_id))).toEqual(beforeCalls.filter(call => restoredSteps.has(call.step_id)));
    expect((await sessionRows(fixture)).executions[0]?.status).toBe('completed');
    if (boundary === 'round-1-bear-challenge') {
      expect(bullAnalyze).not.toHaveBeenCalled();
      expect(bearChallenge).not.toHaveBeenCalled();
      expect(bullRebuttal).toHaveBeenCalledTimes(1);
      expect(judgeEvaluate).toHaveBeenCalledTimes(1);
    } else if (boundary === 'round-2-bull-rebuttal') {
      expect(bullAnalyze).not.toHaveBeenCalled();
      expect(bearChallenge).not.toHaveBeenCalled();
      expect(bullRebuttal).not.toHaveBeenCalled();
      expect(judgeEvaluate).toHaveBeenCalledTimes(1);
    } else {
      expect(models.every(call => call.mock.calls.length === 0)).toBe(true);
    }
  });

  it('reruns an incomplete model node with a new ContextSnapshot and attempt, while restored nodes stay at attempt one', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'incomplete_model' });
    await runPrefix(fixture, 'round-2-bull-rebuttal');
    const existingSnapshots = fixture.db.raw.prepare('SELECT snapshot_id FROM context_snapshots WHERE session_id = ? AND turn_id = ? LIMIT 1').get(fixture.sessionId, fixture.turnId) as { snapshot_id: string };
    expect(existingSnapshots?.snapshot_id).toBeTruthy();
    const snapshotCountBeforeResume = (fixture.db.raw.prepare('SELECT COUNT(*) AS count FROM context_snapshots WHERE session_id = ? AND turn_id = ?').get(fixture.sessionId, fixture.turnId) as { count: number }).count;
    await fixture.db.sessions.saveStep({
      stepId: `step_${fixture.executionId}_evaluate-arguments`, runId: fixture.executionId, nodeId: 'evaluate-arguments',
      parentNodeIds: ['round-1-bull-thesis', 'round-1-bear-challenge', 'round-2-bull-rebuttal', 'select-supporting-evidence'],
      subagent: 'judge', skills: [], status: 'running',
    });
    await fixture.db.sessions.recordModelCall({
      callId: `call_${fixture.executionId}_evaluate-arguments_1`, runId: fixture.executionId,
      stepId: `step_${fixture.executionId}_evaluate-arguments`, subagent: 'judge', provider: config.llm.agent.provider,
      model: config.llm.agent.model, attempt: 1, inputTokens: null, outputTokens: null, cachedInputTokens: null,
      totalTokens: null, latencyMs: 0, finishReason: 'process-lost-before-checkpoint', cost: null, currency: null,
      contextSnapshotId: existingSnapshots.snapshot_id,
    });
    reopen(fixture);
    const runtime = await openRuntime(fixture);
    await runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` });
    await runtime.close();
    const snapshotCountAfterResume = (fixture.db.raw.prepare('SELECT COUNT(*) AS count FROM context_snapshots WHERE session_id = ? AND turn_id = ?').get(fixture.sessionId, fixture.turnId) as { count: number }).count;
    const calls = fixture.db.raw.prepare("SELECT id, attempt FROM model_calls WHERE run_id = ? AND step_id = ? ORDER BY attempt").all(
      fixture.executionId, `step_${fixture.executionId}_evaluate-arguments`,
    ) as Array<{ id: string; attempt: number }>;
    expect(calls).toEqual([
      { id: `call_${fixture.executionId}_evaluate-arguments_1`, attempt: 1 },
      { id: `call_${fixture.executionId}_evaluate-arguments_2`, attempt: 2 },
    ]);
    expect(snapshotCountAfterResume).toBeGreaterThan(snapshotCountBeforeResume);
    expect(await fixture.db.workflowNodeOutputs.getNodeOutput(fixture.executionId, 'evaluate-arguments')).toMatchObject({ completionGeneration: 1 });
  });

  it('does not rerun a checkpointed model node when its WorkflowStep is still running', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'step_running' });
    await runPrefix(fixture, 'round-1-bull-thesis');
    fixture.db.raw.prepare("UPDATE workflow_steps SET status = 'running', duration_ms = NULL, completed_at = NULL WHERE run_id = ? AND node_id = ?")
      .run(fixture.executionId, 'round-1-bull-thesis');
    reopen(fixture);
    const runtime = await openRuntime(fixture);
    const bull = vi.spyOn(runtime.context.bull, 'analyze').mockImplementation(async () => { throw new Error('checkpoint must win over running step'); });
    await runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` });
    await runtime.close();
    expect(bull).not.toHaveBeenCalled();
    expect(await fixture.db.sessions.getStep(fixture.executionId, 'round-1-bull-thesis')).toMatchObject({ status: 'completed', durationMs: null });
  });

  it('treats a completed WorkflowStep without a semantic output as pending and reruns the node', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'missing_checkpoint' });
    await runPrefix(fixture, 'round-1-bull-thesis');
    fixture.db.raw.prepare('DELETE FROM workflow_node_outputs WHERE execution_id = ? AND node_id = ?').run(fixture.executionId, 'round-1-bull-thesis');
    reopen(fixture);
    const runtime = await openRuntime(fixture);
    const bull = vi.spyOn(runtime.context.bull, 'analyze');
    await runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` });
    await runtime.close();
    expect(bull).toHaveBeenCalledTimes(1);
    expect(await fixture.db.workflowNodeOutputs.getNodeOutput(fixture.executionId, 'round-1-bull-thesis')).not.toBeNull();
  });

  it('rejects planner/database checkpoint corruption before acquisition', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'corrupt_checkpoint' });
    await runPrefix(fixture, 'collect-sources');
    const originalOutput = await fixture.db.workflowNodeOutputs.getNodeOutput(fixture.executionId, 'collect-sources');
    const tamperedOutput = createWorkflowNodeOutput({
      ...originalOutput!, dependencyFingerprint: 'f'.repeat(64),
    });
    fixture.db.raw.prepare("UPDATE workflow_node_outputs SET dependency_fingerprint = ? WHERE execution_id = ? AND node_id = ?")
      .run(tamperedOutput.dependencyFingerprint, fixture.executionId, 'collect-sources');
    fixture.db.raw.prepare("UPDATE workflow_node_outputs SET output_fingerprint = ? WHERE execution_id = ? AND node_id = ?")
      .run(tamperedOutput.outputFingerprint, fixture.executionId, 'collect-sources');
    reopen(fixture);
    const runtime = await openRuntime(fixture);
    const providers = providerSpies(runtime.context.financialData);
    const models = modelSpies(runtime);
    await expect(runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` })).rejects.toThrow(/dependency fingerprint/i);
    await runtime.close();
    expect((await sessionRows(fixture)).executions[0]).toMatchObject({ status: 'interrupted', resumeGeneration: 0 });
    expect(providers.every(call => call.mock.calls.length === 0)).toBe(true);
    expect(models.every(call => call.mock.calls.length === 0)).toBe(true);
  });

  it('rejects graph and dependency drift before the execution enters running state', async () => {
    const config = createConfig(dir);
    const graphFixture = await createFixture(db, config, { suffix: 'graph_drift' });
    await runPrefix(graphFixture, 'collect-sources');
    const graphProfile = await graphFixture.db.executionProfiles.getByExecutionId(graphFixture.executionId);
    const incompatibleProfile = createExecutionProfile({ ...graphProfile!, graphFingerprint: 'g'.repeat(64) });
    graphFixture.db.raw.prepare('UPDATE execution_profiles SET graph_fingerprint = ?, fingerprint = ? WHERE execution_id = ?')
      .run(incompatibleProfile.graphFingerprint, incompatibleProfile.fingerprint, graphFixture.executionId);
    await expect(planJudgeResume({
      db: graphFixture.db,
      execution: (await sessionRows(graphFixture)).executions[0]!,
      profile: (await graphFixture.db.executionProfiles.getByExecutionId(graphFixture.executionId))!,
      definition: createJudgeWorkflow(), currentGraphFingerprint: judgeWorkflowGraphFingerprint(),
      provider: config.llm.agent.provider, model: config.llm.agent.model,
      capabilityPlanFingerprint: (graphProfile!.payload as { capabilityPlanFingerprint: string }).capabilityPlanFingerprint,
    })).rejects.toMatchObject({ code: 'INCOMPATIBLE_CHECKPOINT' });
    expect((await sessionRows(graphFixture)).executions[0]?.status).toBe('interrupted');

    const dependencyFixture = await createFixture(db, config, { suffix: 'dependency_drift' });
    await runPrefix(dependencyFixture, 'collect-sources');
    const dependencyOutput = await dependencyFixture.db.workflowNodeOutputs.getNodeOutput(dependencyFixture.executionId, 'collect-sources');
    const dependencyTamper = createWorkflowNodeOutput({ ...dependencyOutput!, dependencyFingerprint: 'd'.repeat(64) });
    dependencyFixture.db.raw.prepare("UPDATE workflow_node_outputs SET dependency_fingerprint = ?, output_fingerprint = ? WHERE execution_id = ? AND node_id = ?")
      .run(dependencyTamper.dependencyFingerprint, dependencyTamper.outputFingerprint, dependencyFixture.executionId, 'collect-sources');
    await expect(planJudgeResume({
      db: dependencyFixture.db,
      execution: (await sessionRows(dependencyFixture)).executions[0]!,
      profile: (await dependencyFixture.db.executionProfiles.getByExecutionId(dependencyFixture.executionId))!,
      definition: createJudgeWorkflow(), currentGraphFingerprint: judgeWorkflowGraphFingerprint(),
      provider: config.llm.agent.provider, model: config.llm.agent.model,
      capabilityPlanFingerprint: ((await dependencyFixture.db.executionProfiles.getByExecutionId(dependencyFixture.executionId))!.payload as { capabilityPlanFingerprint: string }).capabilityPlanFingerprint,
    })).rejects.toThrow(/dependency fingerprint/i);
    expect((await sessionRows(dependencyFixture)).executions[0]?.status).toBe('interrupted');
  });

  it('uses the persisted reasoning profile rather than current UI mode and restores skipped conditional nodes', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'reasoning_profile', reasoningMode: 'reasoning', conditional: true });
    await runPrefix(fixture, 'evaluate-arguments');
    const evaluation = await fixture.db.workflowNodeOutputs.getNodeOutput(fixture.executionId, 'evaluate-arguments');
    const needsExtraPayload = { ...(evaluation!.payload as Record<string, unknown>), needsExtra: true };
    const needsExtraOutput = createWorkflowNodeOutput({ ...evaluation!, payload: needsExtraPayload });
    fixture.db.raw.prepare('UPDATE workflow_node_outputs SET payload_json = ?, output_fingerprint = ? WHERE execution_id = ? AND node_id = ?')
      .run(JSON.stringify(needsExtraPayload), needsExtraOutput.outputFingerprint, fixture.executionId, 'evaluate-arguments');
    reopen(fixture);
    const runtime = await openRuntime(fixture);
    runtime.setReasoning('usual');
    await runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` });
    await runtime.close();
    const outputs = await fixture.db.workflowNodeOutputs.listNodeOutputsForExecution(fixture.executionId);
    expect(outputs.filter(output => output.nodeId === 'conditional-bear-rechallenge' || output.nodeId === 'conditional-bull-rebuttal' || output.nodeId === 'resolve-conflicts').every(output => output.status === 'completed')).toBe(true);

    const skipped = await createFixture(db, config, { suffix: 'conditional_skipped' });
    await runPrefix(skipped, 'check-evidence');
    reopen(skipped);
    const skippedRuntime = await openRuntime(skipped);
    const models = modelSpies(skippedRuntime);
    await skippedRuntime.commands.get('resume')!([skipped.executionId], { input: `/resume ${skipped.executionId}` });
    await skippedRuntime.close();
    const skippedOutputs = await skipped.db.workflowNodeOutputs.listNodeOutputsForExecution(skipped.executionId);
    expect(skippedOutputs.filter(output => output.nodeId === 'conditional-bear-rechallenge' || output.nodeId === 'conditional-bull-rebuttal' || output.nodeId === 'resolve-conflicts').every(output => output.status === 'skipped')).toBe(true);
    expect(models.every(call => call.mock.calls.length === 0)).toBe(true);
  }, 30000);

  it('fences stale generation writers and lets exactly one concurrent resume acquire the execution', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'fencing' });
    await runPrefix(fixture, 'collect-sources');
    const oldExecution = (await sessionRows(fixture)).executions[0]!;
    const [first, second] = await Promise.allSettled([
      fixture.db.sessions.acquireInterruptedExecution(fixture.executionId),
      fixture.db.sessions.acquireInterruptedExecution(fixture.executionId),
    ]);
    expect([first, second].filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect([first, second].filter(result => result.status === 'rejected')).toHaveLength(1);
    const current = (await sessionRows(fixture)).executions[0]!;
    expect(current.resumeGeneration).toBe(1);
    const profile = await fixture.db.executionProfiles.getByExecutionId(fixture.executionId);
    const writer = new JudgeCheckpointWriter({ db: fixture.db, execution: oldExecution, profile: profile!, definition: createJudgeWorkflow() });
    await expect(writer.completedValue('identify-company', { outcome: 'succeeded', company: { ticker: 'BBCA', name: 'stale' }, evidence: { id: 'stale' } } as never))
      .rejects.toThrow(/stale resume generation/i);
  });

  it('repairs message, claim, judgment, and ModelCall projections idempotently without specialist work', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'projection_repair' });
    await runPrefix(fixture, 'evaluate-arguments');
    const outputs = await fixture.db.workflowNodeOutputs.listNodeOutputsForExecution(fixture.executionId);
    fixture.db.raw.prepare("DELETE FROM agent_messages WHERE run_id = ?").run(fixture.executionId);
    fixture.db.raw.prepare("DELETE FROM claims WHERE run_id = ?").run(fixture.executionId);
    fixture.db.raw.prepare("DELETE FROM judgments WHERE run_id = ?").run(fixture.executionId);
    fixture.db.raw.prepare("DELETE FROM model_calls WHERE run_id = ?").run(fixture.executionId);
    await repairJudgeProjections({ db: fixture.db, execution: (await sessionRows(fixture)).executions[0]!, outputs });
    await repairJudgeProjections({ db: fixture.db, execution: (await sessionRows(fixture)).executions[0]!, outputs });
    expect(await fixture.db.conversation.getByRun(fixture.executionId)).toHaveLength(5);
    const expectedClaims = outputs
      .filter(output => ['round-1-bull-thesis', 'round-2-bull-rebuttal'].includes(output.nodeId))
      .reduce((count, output) => count + ((output.payload as { claims?: unknown[] } | null)?.claims?.length ?? 0), 0);
    expect(await fixture.db.claims.getByRun(fixture.executionId)).toHaveLength(expectedClaims);
    const checkpointClaims = outputs
      .filter(output => ['round-1-bull-thesis', 'round-2-bull-rebuttal'].includes(output.nodeId))
      .flatMap(output => ((output.payload as { claims?: unknown[] } | null)?.claims ?? []))
      .sort((a, b) => String((a as { claimId: string }).claimId).localeCompare(String((b as { claimId: string }).claimId)));
    expect((await fixture.db.claims.getByRun(fixture.executionId)).map(storedClaimToClaim)).toEqual(checkpointClaims);
    expect(await fixture.db.judgments.getByRun(fixture.executionId)).not.toBeNull();
    expect(fixture.db.raw.prepare('SELECT COUNT(*) AS count FROM model_calls WHERE run_id = ?').get(fixture.executionId)).toEqual({ count: 4 });
    const messages = await fixture.db.conversation.getByRun(fixture.executionId);
    expect(messages.find(message => message.agent === 'bull')?.metadata).toMatchObject({ seenEvidenceIds: expect.any(Array) });
    expect(messages.find(message => message.agent === 'bear')?.metadata).toMatchObject({ seenEvidenceIds: expect.any(Array) });

    const conditional = await createFixture(db, config, { suffix: 'conditional_projection_repair', reasoningMode: 'reasoning', conditional: true });
    await runPrefix(conditional, 'conditional-bull-rebuttal');
    const conditionalOutputs = await conditional.db.workflowNodeOutputs.listNodeOutputsForExecution(conditional.executionId);
    const conditionalCounterpoints = (await conditional.db.counterpoints.getByRun(conditional.executionId))
      .filter(counterpoint => counterpoint.sourceNodeId === 'conditional-bear-rechallenge');
    expect(conditionalCounterpoints.length).toBeGreaterThan(0);
    conditional.db.raw.prepare("DELETE FROM counterpoints WHERE run_id = ? AND source_node_id = 'conditional-bear-rechallenge'")
      .run(conditional.executionId);
    conditional.db.raw.prepare("DELETE FROM agent_messages WHERE run_id = ?").run(conditional.executionId);
    await repairJudgeProjections({ db: conditional.db, execution: (await sessionRows(conditional)).executions[0]!, outputs: conditionalOutputs });
    await repairJudgeProjections({ db: conditional.db, execution: (await sessionRows(conditional)).executions[0]!, outputs: conditionalOutputs });
    expect((await conditional.db.counterpoints.getByRun(conditional.executionId))
      .filter(counterpoint => counterpoint.sourceNodeId === 'conditional-bear-rechallenge')).toHaveLength(conditionalCounterpoints.length);
    expect((await conditional.db.conversation.getByRun(conditional.executionId)).find(message => message.messageId.endsWith('_conditional'))?.metadata)
      .toMatchObject({ conditional: true, seenEvidenceIds: expect.any(Array) });
  });

  it('loads complete canonical Claim grounding into Bull rebuttal context', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'claim_context' });
    await runPrefix(fixture, 'round-2-bull-rebuttal');
    const claims = (await fixture.db.claims.getByRun(fixture.executionId))
      .filter(claim => claim.claimId.startsWith('claim_')).map(storedClaimToClaim);
    expect(claims.some(claim => (claim.citedFigures?.length ?? 0) > 0)).toBe(true);
    expect(claims.every(claim => claim.policyId === 'claim-policy-v1' && (claim.evidenceLinks?.length ?? 0) > 0)).toBe(true);
    const packets = fixture.db.raw.prepare('SELECT packet_json FROM context_snapshots WHERE session_id = ? AND turn_id = ?')
      .all(fixture.sessionId, fixture.turnId) as Array<{ packet_json: string }>;
    const rebuttal = packets.map(row => JSON.parse(row.packet_json) as { specialist?: { role?: string; phase?: string; bullClaims?: unknown[] } })
      .find(packet => packet.specialist?.role === 'BULL' && packet.specialist.phase === 'REBUTTAL');
    expect(rebuttal?.specialist?.bullClaims).toEqual(claims);
  });

  it('stores full current Bear grounding in the checkpoint and repairs missing rows without model work', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'counterpoint_checkpoint_repair' });
    await runPrefix(fixture, 'round-1-bear-challenge');
    const outputs = await fixture.db.workflowNodeOutputs.listNodeOutputsForExecution(fixture.executionId);
    const output = outputs.find(item => item.nodeId === 'round-1-bear-challenge')!;
    const payload = output.payload as { response: { counterpoints: Array<Record<string, unknown>> }; counterpoints: Array<Record<string, unknown>> };
    expect(payload.response.counterpoints[0]).not.toHaveProperty('counterpointId');
    expect(payload.counterpoints[0]).toMatchObject({
      counterpointId: 'counterpoint:round-1-bear-challenge:1',
      sourceNodeId: 'round-1-bear-challenge',
      policyId: 'counterpoint-policy-v1',
      evidenceIds: [expect.any(String)],
      evidenceLinks: [expect.objectContaining({ relation: 'qualifies' })],
    });
    const callsBefore = fixture.db.raw.prepare('SELECT COUNT(*) AS count FROM model_calls WHERE run_id = ?')
      .get(fixture.executionId) as { count: number };
    fixture.db.raw.prepare('DELETE FROM counterpoints WHERE run_id = ?').run(fixture.executionId);

    await repairJudgeProjections({ db: fixture.db, execution: (await sessionRows(fixture)).executions[0]!, outputs });
    await repairJudgeProjections({ db: fixture.db, execution: (await sessionRows(fixture)).executions[0]!, outputs });

    const stored = await fixture.db.counterpoints.getByRun(fixture.executionId);
    expect(stored).toHaveLength(payload.counterpoints.length);
    expect(stored[0]).toMatchObject({
      counterpointId: payload.counterpoints[0]!.counterpointId,
      evidenceIds: payload.counterpoints[0]!.evidenceIds,
      evidenceLinks: payload.counterpoints[0]!.evidenceLinks,
      policyId: payload.counterpoints[0]!.policyId,
    });
    expect(fixture.db.raw.prepare('SELECT COUNT(*) AS count FROM model_calls WHERE run_id = ?')
      .get(fixture.executionId)).toEqual(callsBefore);
    const decoded = await decodeJudgeCheckpoint('round-1-bear-challenge', output, fixture.db, {
      id: fixture.executionId, ticker: 'BBCA',
    } as never) as { counterpoints: Array<Record<string, unknown>> };
    expect(decoded.counterpoints).toEqual(payload.counterpoints);
  });

  it('reads a pre-T3 Bear checkpoint without fabricating Counterpoint grounding during repair', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'legacy_counterpoint_repair' });
    await runPrefix(fixture, 'round-1-bear-challenge');
    const storedOutputs = await fixture.db.workflowNodeOutputs.listNodeOutputsForExecution(fixture.executionId);
    const historicalOutputs = storedOutputs.map(output => {
      if (output.nodeId !== 'round-1-bear-challenge' || !output.payload) return output;
      const payload = output.payload as { response: Record<string, unknown>; counterpoints: Array<Record<string, unknown>> };
      const counterpoints = payload.counterpoints.map(point => ({
        targetClaimId: point.targetClaimId, argument: point.argument, strength: point.strength,
      }));
      return { ...output, payload: {
        ...payload,
        response: { ...payload.response, counterpoints },
        counterpoints,
      } };
    });
    fixture.db.raw.prepare('DELETE FROM counterpoints WHERE run_id = ?').run(fixture.executionId);
    const historical = historicalOutputs.find(output => output.nodeId === 'round-1-bear-challenge')!;
    const decoded = await decodeJudgeCheckpoint('round-1-bear-challenge', historical, fixture.db, {
      id: fixture.executionId, ticker: 'BBCA',
    } as never) as { counterpoints: Array<Record<string, unknown>> };
    expect(decoded.counterpoints[0]).toEqual(expect.objectContaining({ targetClaimId: 'claim_1' }));
    expect(decoded.counterpoints[0]).not.toHaveProperty('evidenceIds');
    await repairJudgeProjections({ db: fixture.db, execution: (await sessionRows(fixture)).executions[0]!, outputs: historicalOutputs });
    await repairJudgeProjections({ db: fixture.db, execution: (await sessionRows(fixture)).executions[0]!, outputs: historicalOutputs });
    expect(await fixture.db.counterpoints.getByRun(fixture.executionId)).toEqual([]);
  });

  it.each([
    'current response with legacy canonical list',
    'legacy response with partial current canonical fields',
    'current checkpoint missing policy fingerprint',
  ])('fails closed on a downgraded or partial T3 checkpoint: %s', async (malformation) => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: `bad_counterpoint_${malformation.replaceAll(/[^a-z]+/gi, '_')}` });
    await runPrefix(fixture, 'round-1-bear-challenge');
    const outputs = await fixture.db.workflowNodeOutputs.listNodeOutputsForExecution(fixture.executionId);
    const bearOutput = outputs.find(output => output.nodeId === 'round-1-bear-challenge')!;
    const payload = bearOutput.payload as {
      response: Record<string, unknown> & { counterpoints: Array<Record<string, unknown>> };
      counterpoints: Array<Record<string, unknown>>;
    };
    const historicalPoints = payload.counterpoints.map(point => ({
      targetClaimId: point.targetClaimId,
      argument: point.argument,
      strength: point.strength,
    }));
    let response = payload.response;
    let counterpoints = payload.counterpoints;

    if (malformation === 'current response with legacy canonical list') {
      counterpoints = historicalPoints;
    } else if (malformation === 'legacy response with partial current canonical fields') {
      response = { ...payload.response, counterpoints: historicalPoints };
      const current = payload.counterpoints[0]!;
      counterpoints = [{
        ...historicalPoints[0],
        counterpointId: current.counterpointId,
        evidenceIds: current.evidenceIds,
        evidenceLinks: current.evidenceLinks,
      }, ...historicalPoints.slice(1)];
    } else {
      counterpoints = payload.counterpoints.map((point, index) => {
        if (index !== 0) return point;
        return Object.fromEntries(Object.entries(point).filter(([key]) => key !== 'policyFingerprint'));
      });
    }

    const malformedOutput = {
      ...bearOutput,
      payload: { ...payload, response, counterpoints },
    } as typeof bearOutput;
    const malformedOutputs = outputs.map(output => output.nodeId === 'round-1-bear-challenge' ? malformedOutput : output);
    fixture.db.raw.prepare('DELETE FROM counterpoints WHERE run_id = ?').run(fixture.executionId);

    await expect(decodeJudgeCheckpoint('round-1-bear-challenge', malformedOutput, fixture.db, {
      id: fixture.executionId, ticker: 'BBCA',
    } as never)).rejects.toThrow();
    await expect(repairJudgeProjections({
      db: fixture.db, execution: (await sessionRows(fixture)).executions[0]!, outputs: malformedOutputs,
    })).rejects.toThrow();
    expect(await fixture.db.counterpoints.getByRun(fixture.executionId)).toEqual([]);
  });

  it('repairs a pre-T2 Bull checkpoint without inventing Claim links or policy identity', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'legacy_claim_repair' });
    await runPrefix(fixture, 'round-1-bull-thesis');
    const outputs = await fixture.db.workflowNodeOutputs.listNodeOutputsForExecution(fixture.executionId);
    const historical = outputs.map(output => {
      if (output.nodeId !== 'round-1-bull-thesis' || !output.payload) return output;
      const payload = output.payload as { claims: Array<Record<string, unknown>> };
      return { ...output, payload: { ...payload, claims: payload.claims.map(claim => {
        const { evidenceLinks: _links, policyId: _policyId, policyFingerprint: _fingerprint, ...legacy } = claim;
        return legacy;
      }) } };
    });
    fixture.db.raw.prepare('DELETE FROM claims WHERE run_id = ?').run(fixture.executionId);
    const execution = (await sessionRows(fixture)).executions[0]!;
    await repairJudgeProjections({ db: fixture.db, execution, outputs: historical });
    await repairJudgeProjections({ db: fixture.db, execution, outputs: historical });
    const restored = await fixture.db.claims.getByRun(fixture.executionId);
    expect(restored.length).toBeGreaterThan(0);
    expect(restored.every(claim => claim.policyId === undefined && claim.evidenceLinks === undefined)).toBe(true);
    expect(restored.some(claim => (claim.citedFigures?.length ?? 0) > 0)).toBe(true);
  });

  it('repairs partial artifacts after restart, retains valid rows, and fails closed on immutable conflict', async () => {
    const config = createConfig(dir);
    const runtime = await createHarnessSession(db, config, { write: () => {} });
    await runtime.commands.get('judge')!(['BBCA']);
    const sessionId = runtime.conversation.id;
    const execution = (await db.sessions.getSessionArtifacts(sessionId)).executions[0]!;
    await runtime.close();
    const before = await db.artifacts.getByExecution(execution.id);
    db.raw.prepare("DELETE FROM artifacts WHERE execution_id = ? AND kind IN ('BEAR_CASE', 'VERDICT')").run(execution.id);
    db.raw.close();
    db = openDb({ homeDir: dir });
    const restarted = await createHarnessSession(db, config, { write: () => {} });
    const repaired = await db.artifacts.getByExecution(execution.id);
    expect(repaired).toHaveLength(3);
    expect(repaired.find(artifact => artifact.kind === 'BULL_CASE')).toEqual(before.find(artifact => artifact.kind === 'BULL_CASE'));
    await restarted.close();

    const bull = repaired.find(artifact => artifact.kind === 'BULL_CASE')!;
    const changed = structuredClone(bull.payload) as Record<string, unknown>;
    (changed.thesis as Record<string, unknown>).reasoning = 'conflicting immutable payload';
    db.raw.prepare('UPDATE artifacts SET payload_json = ? WHERE artifact_id = ?').run(JSON.stringify(changed), bull.artifactId);
    db.raw.prepare("DELETE FROM artifacts WHERE execution_id = ? AND kind IN ('BEAR_CASE', 'VERDICT')").run(execution.id);
    db.raw.close();
    db = openDb({ homeDir: dir });
    await expect(createHarnessSession(db, config, { write: () => {} })).rejects.toThrow(/immutable write conflict/i);
  });

  it('cancels an active resumed generation and rejects a second resume of the cancelled Execution', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'cancel_resume' });
    await runPrefix(fixture, 'round-1-bear-challenge');
    reopen(fixture);
    const runtime = await openRuntime(fixture);
    const controller = new AbortController();
    const rebuttal = vi.spyOn(runtime.context.bull, 'rebuttal').mockImplementation(async args => {
      const result = await (await buildContext(fixture.db, config, { sessionId: fixture.sessionId })).bull.rebuttal(args);
      controller.abort(new DOMException('cancel resumed run', 'AbortError'));
      return result;
    });
    await expect(runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}`, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ABORTED' });
    await runtime.close();
    expect(rebuttal).toHaveBeenCalledTimes(1);
    expect((await sessionRows(fixture)).executions[0]).toMatchObject({ status: 'cancelled', resumeGeneration: 1 });
    expect((await sessionRows(fixture)).turns[0]).toMatchObject({ id: fixture.turnId, status: 'stopped' });
    const second = await openRuntime(fixture);
    await expect(second.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` }))
      .rejects.toMatchObject({ code: 'RESUME_NOT_FOUND' });
    await second.close();
  });

  it('reconciles process loss during generation one and resumes the same execution at generation two', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'process_loss_resume' });
    await runPrefix(fixture, 'round-1-bull-thesis');
    const acquired = await fixture.db.sessions.acquireInterruptedExecution(fixture.executionId);
    const definition = createJudgeWorkflow();
    const profile = await fixture.db.executionProfiles.getByExecutionId(fixture.executionId);
    const plan = await planJudgeResume({
      db: fixture.db, execution: acquired, profile: profile!, definition,
      currentGraphFingerprint: judgeWorkflowGraphFingerprint(), provider: config.llm.agent.provider, model: config.llm.agent.model,
      capabilityPlanFingerprint: (profile!.payload as { capabilityPlanFingerprint: string }).capabilityPlanFingerprint,
    });
    const context = buildContext(fixture.db, config, { sessionId: fixture.sessionId });
    const recorder = new WorkflowTraceRecorder({ runId: fixture.executionId, definition, store: fixture.db.sessions });
    const writer = new JudgeCheckpointWriter({ db: fixture.db, execution: acquired, profile: profile!, definition, initialOutputs: plan.outputs });
    const decision = {};
    const payload = profile!.payload as { reasoningMode: 'usual' | 'reasoning'; conditional: boolean; researchers: { market: boolean; news: boolean } };
    const executors = createJudgeNodeExecutors({
      deps: {
        capabilityGateway: context.capabilityGateway,
        bull: context.bull,
        bear: context.bear,
        judge: context.judge,
        validator: context.validator,
        researchers: payload.researchers,
        evidence: fixture.db.evidence,
        financialSnapshots: fixture.db.financialSnapshots,
        conversation: fixture.db.conversation,
        claims: fixture.db.claims,
        counterpoints: fixture.db.counterpoints,
        judgments: fixture.db.judgments,
      },
      ticker: 'BBCA', runId: fixture.executionId, events: () => {}, progress: () => {}, decision,
      reasoning: payload.reasoningMode === 'reasoning', conditional: payload.conditional,
      executionStartedAt: acquired.createdAt, lifecycle: { sessionId: fixture.sessionId, turnId: fixture.turnId },
      trace: { recordSubagentResult: (nodeId, result) => recorder.recordSubagentResult(nodeId, result) },
      checkpoint: (nodeId, value) => writer.completedValue(nodeId, value),
    });
    await expect(new WorkflowRunner({
      onEvent: event => recorder.handle(event),
      onNodeCompleted: async (node, value, inputs) => {
        await writer.completed(node, value, inputs);
        if (node.id === 'round-1-bear-challenge') throw new Error('simulated process loss after generation-one checkpoint');
      },
      onNodeSkipped: node => writer.skipped(node), onNodeFailed: node => writer.optionalFailure(node, new Error('optional failure')),
    }).run(definition, createJudgeCommandContext({
      reasoningMode: payload.reasoningMode, conditional: payload.conditional, researchers: payload.researchers, executors, decision,
    }), { restored: plan.restored })).rejects.toThrow(/Required workflow step failed/i);
    expect((await sessionRows(fixture)).executions[0]).toMatchObject({ status: 'running', resumeGeneration: 1 });

    reopen(fixture);
    const runtime = await openRuntime(fixture);
    await runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` });
    await runtime.close();
    expect((await sessionRows(fixture)).executions[0]).toMatchObject({ id: fixture.executionId, attempt: 1, status: 'completed', resumeGeneration: 2 });
    expect((await sessionRows(fixture)).turns[0]).toMatchObject({ id: fixture.turnId, status: 'completed' });
  });

  it('covers representative pre/post-snapshot and semantic crash boundaries through restart', async () => {
    const boundaries: Array<{ node: JudgeNodeId; postSnapshot: boolean; reasoningMode?: 'usual' | 'reasoning'; conditional?: boolean }> = [
      { node: 'identify-company', postSnapshot: false },
      { node: 'collect-sources', postSnapshot: true },
      { node: 'round-1-bull-thesis', postSnapshot: true },
      { node: 'round-1-bear-challenge', postSnapshot: true },
      { node: 'round-2-bull-rebuttal', postSnapshot: true },
      { node: 'evaluate-arguments', postSnapshot: true },
      { node: 'conditional-bear-rechallenge', postSnapshot: true, reasoningMode: 'reasoning', conditional: true },
      { node: 'resolve-conflicts', postSnapshot: true, reasoningMode: 'reasoning', conditional: true },
      { node: 'check-evidence', postSnapshot: true },
      { node: 'synthesize-verdict', postSnapshot: true },
    ];
    for (const [index, boundary] of boundaries.entries()) {
      const config = createConfig(dir);
      const fixture = await createFixture(db, config, {
        suffix: `matrix_${index}_${boundary.node.replaceAll('-', '_')}`,
        reasoningMode: boundary.reasoningMode, conditional: boundary.conditional,
      });
      await runPrefix(fixture, boundary.node);
      reopen(fixture);
      const runtime = await openRuntime(fixture);
      const providers = providerSpies(runtime.context.financialData);
      await runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` });
      await runtime.close();
      const artifacts = await db.artifacts.getByExecution(fixture.executionId);
      expect((await sessionRows(fixture)).executions[0]).toMatchObject({ id: fixture.executionId, turnId: fixture.turnId, status: 'completed' });
      expect(artifacts).toHaveLength(3);
      if (boundary.postSnapshot) expect(providers.every(call => call.mock.calls.length === 0)).toBe(true);
    }
  }, 60000);

  it('publishes WorkingContext exactly once across successful resume and later restart reconciliation', async () => {
    const config = createConfig(dir);
    const fixture = await createFixture(db, config, { suffix: 'working_context_resume' });
    await runPrefix(fixture, 'evaluate-arguments');
    reopen(fixture);
    const runtime = await openRuntime(fixture);
    await runtime.commands.get('resume')!([fixture.executionId], { input: `/resume ${fixture.executionId}` });
    await runtime.close();
    const first = await fixture.db.workingContext.current(fixture.sessionId);
    const firstHistory = await fixture.db.workingContext.history(fixture.sessionId);
    expect(firstHistory).toHaveLength(1);
    expect(first?.activeVerdictRef).toMatchObject({ kind: 'VERDICT', artifactId: `artifact_verdict_${fixture.executionId}` });
    reopen(fixture);
    const restarted = await openRuntime(fixture);
    await restarted.close();
    expect(await fixture.db.workingContext.history(fixture.sessionId)).toHaveLength(1);
    expect(await fixture.db.workingContext.current(fixture.sessionId)).toEqual(first);
  });
});
