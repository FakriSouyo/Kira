import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { checkpointKindForNode, createJudgeWorkflow, createJudgeExecutionProfile, judgeWorkflowGraphFingerprint, type JudgeExecutionProfile, type JudgeNodeId } from '@harness/command-judge';
import { createCapabilityPlan } from '@harness/capability';
import { COUNTERPOINT_POLICY_FINGERPRINT, COUNTERPOINT_POLICY_ID } from '@harness/execution';
import { createExecutionProfile, createWorkflowNodeOutput, type JsonValue, type ResearchExecution, type WorkflowNodeOutput } from '@harness/session-core';
import { decodeJudgeCheckpoint, JudgeCheckpointWriter, planJudgeResume, workflowDependencyFingerprint, type JudgeCheckpointStores } from '@harness/engine';
import { JUDGE_WORKFLOW_VERSION } from '@harness/command-judge';

const execution: ResearchExecution = {
  id: 'execution-ua13-checkpoint',
  sessionId: 'session-ua13-checkpoint',
  turnId: 'turn-ua13-checkpoint',
  attempt: 1,
  ticker: 'BBCA',
  command: 'judge',
  status: 'interrupted',
  executionTime: null,
  error: null,
  createdAt: '2026-09-26T00:00:00.000Z',
  completedAt: null,
  resumeGeneration: 2,
};

const definition = createJudgeWorkflow();
const graphFingerprint = judgeWorkflowGraphFingerprint(definition);
const capabilityPlan = createCapabilityPlan({ list: () => [] }, []);

function createProfile(options: {
  ticker?: string;
  researchers?: { market: boolean; news: boolean };
  reasoningMode?: 'usual' | 'reasoning';
  conditional?: boolean;
  runtimePlan?: JsonValue;
  } = {}): JudgeExecutionProfile {
  return createJudgeExecutionProfile({
    executionId: execution.id,
    ticker: options.ticker ?? execution.ticker,
    reasoningMode: options.reasoningMode ?? 'usual',
    conditional: options.conditional ?? false,
    researchers: options.researchers ?? { market: true, news: true },
    provider: 'test-provider',
    model: 'test-model',
    capabilityPlan,
    ...(options.runtimePlan ? { runtimePlan: options.runtimePlan } : {}),
    createdAt: execution.createdAt,
  });
}

function withProfile(profile: JudgeExecutionProfile, overrides: Partial<Omit<JudgeExecutionProfile, 'schemaVersion' | 'fingerprint' | 'payload'>> & { payload?: JsonValue } = {}): JudgeExecutionProfile {
  const { schemaVersion: _schemaVersion, fingerprint: _fingerprint, ...input } = profile;
  return createExecutionProfile({ ...input, ...overrides } as never) as JudgeExecutionProfile;
}

function createStores(initial: WorkflowNodeOutput[] = [], options: {
  evidence?: Array<Record<string, unknown>>;
  snapshots?: Map<string, Record<string, unknown>>;
  contextSnapshots?: Map<string, Record<string, unknown>>;
} = {}) {
  const outputs = [...initial];
  const save = vi.fn(async (output: WorkflowNodeOutput) => {
    outputs.push(output);
    return output;
  });
  const list = vi.fn(async (executionId: string) => outputs.filter(output => output.executionId === executionId));
  const stores = {
    workflowNodeOutputs: { save, listNodeOutputsForExecution: list },
    financialSnapshots: {
      getById: vi.fn(async (snapshotId: string) => (options.snapshots?.get(snapshotId) ?? null) as never),
    },
    evidence: {
      getManyByIdsForRun: vi.fn(async (_executionId: string, ids: string[]) => {
        const byId = new Map((options.evidence ?? []).map(item => [item.id as string, item]));
        return ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) as never;
      }),
    },
    contextSnapshots: {
      getById: vi.fn(async (snapshotId: string) => (options.contextSnapshots?.get(snapshotId) ?? null) as never),
    },
  } as unknown as JudgeCheckpointStores;
  return { stores, outputs, save, list };
}

function createOutput(
  nodeId: JudgeNodeId,
  payload: JsonValue | null,
  options: {
  profile?: JudgeExecutionProfile;
    node?: { id: string; dependsOn?: string[] };
    status?: 'completed' | 'skipped';
    dependencyFingerprint?: string;
    completionGeneration?: number;
  } = {},
) {
  const profile = options.profile ?? createProfile();
  const node = options.node ?? definition.nodes.find(candidate => candidate.id === nodeId)!;
  return createWorkflowNodeOutput({
    executionId: execution.id,
    workflowId: profile.workflowId,
    workflowVersion: profile.workflowVersion,
    nodeId,
    status: options.status ?? 'completed',
    outputKind: checkpointKindForNode(nodeId),
    dependencyFingerprint: options.dependencyFingerprint ?? workflowDependencyFingerprint(node, new Map(), profile.fingerprint),
    payload,
    completionGeneration: options.completionGeneration ?? execution.resumeGeneration,
    createdAt: execution.createdAt,
  });
}

function planOptions(stores: JudgeCheckpointStores, profile: JudgeExecutionProfile = createProfile(), options: {
  execution?: ResearchExecution;
  currentGraphFingerprint?: string;
  provider?: string;
  model?: string;
  runtimePlanFingerprint?: string;
  capabilityPlanFingerprint?: string;
  nodes?: typeof definition.nodes;
} = {}) {
  return {
    stores,
    execution: options.execution ?? execution,
    profile,
    definition: { ...definition, nodes: options.nodes ?? definition.nodes },
    currentGraphFingerprint: options.currentGraphFingerprint ?? graphFingerprint,
    provider: options.provider ?? 'test-provider',
    model: options.model ?? 'test-model',
    ...(options.runtimePlanFingerprint !== undefined ? { runtimePlanFingerprint: options.runtimePlanFingerprint } : {}),
    capabilityPlanFingerprint: options.capabilityPlanFingerprint ?? profile.payload.capabilityPlanFingerprint,
  };
}

const evidenceId = '11111111-1111-4111-8111-111111111111';
const evidence = { id: evidenceId, ticker: 'BBCA', source: 'test-source', data: { metric: 1 } };

const validClaim = {
  claimId: 'claim_1',
  statement: 'The business has stable operating fundamentals.',
  confidence: 'moderate',
  reasoning: 'The available company report supports this assessment.',
  evidenceIds: [evidenceId],
};

const validJudgment = {
  ticker: 'BBCA',
  score: 70,
  stance: 'bullish',
  confidence: 'moderate',
  breakdown: { financialHealth: 70, growth: 70, valuation: 70, marketMomentum: null, risk: null },
  summary: 'A measured positive outlook.',
};

const validAudit = { subagent: 'bull', skills: [] };

describe('Judge checkpoint/resume engine core', () => {
  it('keeps dependency fingerprints deterministic and dependent on ordered upstream fingerprints', () => {
    const node = { id: 'target', dependsOn: ['first', 'second'] };
    const outputs = new Map([['first', 'a'.repeat(64)], ['second', 'b'.repeat(64)]]);
    const first = workflowDependencyFingerprint(node, outputs, 'profile');
    expect(workflowDependencyFingerprint(node, outputs, 'profile')).toBe(first);
    expect(workflowDependencyFingerprint(node, new Map([['first', 'b'.repeat(64)], ['second', 'a'.repeat(64)]]), 'profile')).not.toBe(first);
    expect(workflowDependencyFingerprint(node, outputs, 'different-profile')).not.toBe(first);
  });

  it('persists completed checkpoints through the supplied store with the original output envelope', async () => {
    const profile = createProfile();
    const { stores, outputs, save } = createStores();
    const writer = new JudgeCheckpointWriter({ stores, execution, profile, definition });

    await writer.completedValue('identify-company', { data: { ticker: 'BBCA' }, metadata: { source: 'fixture' } });

    expect(save).toHaveBeenCalledTimes(1);
    expect(outputs[0]).toMatchObject({
      executionId: execution.id,
      workflowId: 'judge',
      workflowVersion: JUDGE_WORKFLOW_VERSION,
      nodeId: 'identify-company',
      status: 'completed',
      outputKind: checkpointKindForNode('identify-company'),
      completionGeneration: execution.resumeGeneration,
      payload: { data: { ticker: 'BBCA' }, metadata: { source: 'fixture' } },
    });
  });

  it('persists skipped checkpoints with a null payload', async () => {
    const { stores, outputs } = createStores();
    const writer = new JudgeCheckpointWriter({ stores, execution, profile: createProfile(), definition });
    await writer.skipped(definition.nodes.find(node => node.id === 'fetch-market-data')! as never);
    expect(outputs[0]).toMatchObject({ nodeId: 'fetch-market-data', status: 'skipped', payload: null, completionGeneration: 2 });
  });

  it.each([
    ['fetch-market-data', 'market-provider'] as const,
    ['fetch-news', 'news-provider'] as const,
  ])('persists %s optional failures in the existing payload shape', async (nodeId, errorCode) => {
    const { stores, outputs } = createStores();
    const writer = new JudgeCheckpointWriter({ stores, execution, profile: createProfile(), definition });
    await writer.optionalFailure(definition.nodes.find(node => node.id === nodeId)! as never, Object.assign(new Error('unavailable'), { code: errorCode }));
    expect(outputs[0]).toMatchObject({
      nodeId,
      status: 'completed',
      outputKind: checkpointKindForNode(nodeId),
      completionGeneration: execution.resumeGeneration,
      payload: { outcome: 'optional-failure', errorCode },
    });
  });

  it('uses initial outputs when calculating the next dependency fingerprint', async () => {
    const profile = createProfile();
    const upstream = createOutput('identify-company', { ok: true });
    const { stores, outputs } = createStores();
    const writer = new JudgeCheckpointWriter({ stores, execution, profile, definition, initialOutputs: [upstream] });
    await writer.completedValue('fetch-financials', { data: { ticker: 'BBCA' } });
    const node = definition.nodes.find(candidate => candidate.id === 'fetch-financials')!;
    expect(outputs[0]!.dependencyFingerprint).toBe(workflowDependencyFingerprint(node, new Map([['identify-company', upstream.outputFingerprint]]), profile.fingerprint));
  });

  it('rejects malformed profile identity, workflow version, and graph fingerprint', async () => {
    const { stores } = createStores();
    const profile = createProfile();
    await expect(planJudgeResume(planOptions(stores, withProfile(profile, { command: 'research' })))).rejects.toThrow(/unsupported Judge execution profile/i);
    await expect(planJudgeResume(planOptions(stores, withProfile(profile, { workflowId: 'research' })))).rejects.toThrow(/unsupported Judge execution profile/i);
    await expect(planJudgeResume(planOptions(stores, withProfile(profile, { workflowVersion: 99 })))).rejects.toMatchObject({ code: 'INCOMPATIBLE_CHECKPOINT' });
    await expect(planJudgeResume(planOptions(stores, withProfile(profile, { graphFingerprint: 'f'.repeat(64) })))).rejects.toMatchObject({ code: 'INCOMPATIBLE_CHECKPOINT' });
    await expect(planJudgeResume(planOptions(stores, withProfile(profile, { ticker: 'BBRI' })))).rejects.toThrow(/ticker does not match/i);
    const invalidSchema = { ...profile, schemaVersion: 99 } as unknown as JudgeExecutionProfile;
    await expect(planJudgeResume(planOptions(stores, invalidSchema))).rejects.toThrow(/unsupported Judge execution profile/i);
  });

  it('rejects required capability-less and malformed capability profiles', async () => {
    const { stores } = createStores();
    const profile = createProfile();
    const capabilityLessPayload = { ...profile.payload } as Record<string, JsonValue>;
    delete capabilityLessPayload.capabilityPlan;
    delete capabilityLessPayload.capabilityPlanFingerprint;
    const capabilityLess = withProfile(profile, { payload: capabilityLessPayload as JsonValue });
    await expect(planJudgeResume(planOptions(stores, capabilityLess))).rejects.toMatchObject({ code: 'INCOMPATIBLE_CHECKPOINT' });

    const malformed = withProfile(profile, { payload: { ...profile.payload, capabilityPlan: { invalid: true } } as unknown as JsonValue });
    await expect(planJudgeResume(planOptions(stores, malformed))).rejects.toMatchObject({ code: 'INCOMPATIBLE_CHECKPOINT' });
  });

  it('preserves capability, provider/model, and semantic runtime mismatch errors', async () => {
    const { stores } = createStores();
    const profile = createProfile({ runtimePlan: { runtimeFingerprint: 'runtime-a' } });
    await expect(planJudgeResume(planOptions(stores, profile, { capabilityPlanFingerprint: 'changed-capability' }))).rejects.toMatchObject({ code: 'CAPABILITY_MISMATCH' });
    await expect(planJudgeResume(planOptions(stores, profile, { provider: 'other-provider' }))).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
    await expect(planJudgeResume(planOptions(stores, profile, { model: 'other-model' }))).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
    await expect(planJudgeResume(planOptions(stores, profile, { runtimePlanFingerprint: 'runtime-b' }))).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
  });

  it('rejects future-generation checkpoints before decoding', async () => {
    const profile = createProfile();
    const output = createOutput('identify-company', { data: {} }, { profile, completionGeneration: execution.resumeGeneration + 1 });
    const { stores } = createStores([output]);
    await expect(planJudgeResume(planOptions(stores, profile))).rejects.toThrow(/future resume generation/i);
  });

  it('rejects a dependency fingerprint mismatch and never jumps over a missing dependency', async () => {
    const profile = createProfile();
    const wrong = createOutput('identify-company', { data: {} }, { profile, dependencyFingerprint: 'd'.repeat(64) });
    const { stores } = createStores([wrong]);
    await expect(planJudgeResume(planOptions(stores, profile))).rejects.toThrow(/dependency fingerprint mismatch/i);

    const dependent = createOutput('fetch-financials', { data: {} }, { profile });
    const missingFrontier = createStores([dependent]);
    const plan = await planJudgeResume(planOptions(missingFrontier.stores, profile));
    expect(plan.restored).toEqual([]);
    expect(plan.outputs).toEqual([]);
  });

  it('preserves enabled/skipped disagreement against the original profile', async () => {
    const profile = createProfile({ researchers: { market: false, news: true } });
    const marketNode = definition.nodes.find(node => node.id === 'fetch-market-data')!;
    const isolatedMarket = { ...marketNode, dependsOn: [] };
    const nodeDefinition = { ...definition, nodes: [isolatedMarket] };
    const skipped = createOutput('fetch-market-data', null, { profile, node: isolatedMarket, status: 'skipped' });
    const stores = createStores([skipped]);
    const valid = await planJudgeResume(planOptions(stores.stores, profile, { nodes: nodeDefinition.nodes }));
    expect(valid.restored).toEqual([{ nodeId: 'fetch-market-data', status: 'skipped' }]);

    const completed = createOutput('fetch-market-data', { outcome: 'optional-failure', errorCode: 'PROVIDER_ERROR' }, { profile, node: isolatedMarket });
    const invalid = createStores([completed]);
    await expect(planJudgeResume(planOptions(invalid.stores, profile, { nodes: nodeDefinition.nodes }))).rejects.toThrow(/completed but disabled/i);
  });

  it('derives conditional-node enablement from the restored evaluation and persisted profile', async () => {
    const profile = createProfile({ conditional: true });
    const evaluationNode = { ...definition.nodes.find(node => node.id === 'evaluate-arguments')!, dependsOn: [] };
    const conditionalNode = { ...definition.nodes.find(node => node.id === 'conditional-bear-rechallenge')!, dependsOn: [] };
    const nodes = [evaluationNode, conditionalNode];
    const makeRows = (needsExtra: boolean) => {
      const evaluation = createOutput('evaluate-arguments', {
        judgment: validJudgment,
        allClaims: [],
        needsExtra,
        audit: validAudit,
      } as unknown as JsonValue, { profile, node: evaluationNode });
      const skipped = createOutput('conditional-bear-rechallenge', null, {
        profile,
        node: conditionalNode,
        status: 'skipped',
      });
      return createStores([evaluation, skipped]);
    };

    const noExtra = makeRows(false);
    await expect(planJudgeResume(planOptions(noExtra.stores, profile, { nodes }))).resolves.toMatchObject({
      restored: [{ nodeId: 'evaluate-arguments', status: 'completed' }, { nodeId: 'conditional-bear-rechallenge', status: 'skipped' }],
    });

    const extra = makeRows(true);
    await expect(planJudgeResume(planOptions(extra.stores, profile, { nodes }))).rejects.toThrow(/skipped but enabled/i);

    const reasoningProfile = createProfile({ reasoningMode: 'reasoning', conditional: false });
    const reasoningEvaluation = createOutput('evaluate-arguments', {
      judgment: validJudgment,
      allClaims: [],
      needsExtra: false,
      audit: validAudit,
    } as unknown as JsonValue, { profile: reasoningProfile, node: evaluationNode });
    const reasoningSkipped = createOutput('conditional-bear-rechallenge', null, {
      profile: reasoningProfile,
      node: conditionalNode,
      status: 'skipped',
    });
    const reasoningRows = createStores([reasoningEvaluation, reasoningSkipped]);
    await expect(planJudgeResume(planOptions(reasoningRows.stores, reasoningProfile, { nodes }))).rejects.toThrow(/skipped but enabled/i);
  });

  it('requires referenced ContextSnapshots to exist and belong to the same Session and Turn', async () => {
    const profile = createProfile();
    const auditPayload = { claims: 0, challenges: 0, evidenceIds: [], audit: { subagent: 'judge', skills: [], contextSnapshotId: 'snapshot-context' } } as unknown as JsonValue;
    const isolatedNode = { ...definition.nodes.find(node => node.id === 'check-evidence')!, dependsOn: [] };
    const output = createOutput('check-evidence', auditPayload, { profile, node: isolatedNode });
    const absent = createStores([output]);
    await expect(planJudgeResume(planOptions(absent.stores, profile, { nodes: [isolatedNode] }))).rejects.toThrow(/missing ContextSnapshot/i);

    const wrongOwner = createStores([output], { contextSnapshots: new Map([['snapshot-context', { snapshotId: 'snapshot-context', sessionId: 'elsewhere', turnId: execution.turnId }]]) });
    await expect(planJudgeResume(planOptions(wrongOwner.stores, profile, { nodes: [isolatedNode] }))).rejects.toThrow(/outside its lifecycle/i);

    const rightOwner = createStores([output], { contextSnapshots: new Map([['snapshot-context', { snapshotId: 'snapshot-context', sessionId: execution.sessionId, turnId: execution.turnId }]]) });
    await expect(planJudgeResume(planOptions(rightOwner.stores, profile, { nodes: [isolatedNode] }))).resolves.toMatchObject({ restored: [{ nodeId: 'check-evidence', status: 'completed' }] });
  });

  it('re-verifies financial observations while decoding checkpoints', async () => {
    const output = createOutput('identify-company', { data: { ticker: 'BBCA' } });
    await expect(decodeJudgeCheckpoint('identify-company', output, createStores().stores, execution)).rejects.toThrow();
  });

  it('validates FinancialSnapshot identity and fingerprint for collect-sources', async () => {
    const snapshot = { snapshotId: 'snapshot-source', executionId: execution.id, subject: { ticker: 'BBCA' }, fingerprint: 'f'.repeat(64), materializedEvidenceIds: [] };
    const manifest = { snapshotId: snapshot.snapshotId, snapshotFingerprint: 'e'.repeat(64), evidenceIds: [], marketEvidenceIds: [], newsEvidenceIds: [], marketAvailable: false, newsAvailable: false };
    const output = createOutput('collect-sources', manifest);
    const stores = createStores([], { snapshots: new Map([[snapshot.snapshotId, snapshot]]) });
    await expect(decodeJudgeCheckpoint('collect-sources', output, stores.stores, execution)).rejects.toThrow(/invalid FinancialSnapshot reference/i);

    for (const mismatchedSnapshot of [
      { ...snapshot, executionId: 'other-execution' },
      { ...snapshot, subject: { ticker: 'BBRI' } },
    ]) {
      const mismatched = createStores([], { snapshots: new Map([[snapshot.snapshotId, mismatchedSnapshot]]) });
      const matchingManifest = createOutput('collect-sources', { ...manifest, snapshotFingerprint: snapshot.fingerprint } as JsonValue);
      await expect(decodeJudgeCheckpoint('collect-sources', matchingManifest, mismatched.stores, execution)).rejects.toThrow(/invalid FinancialSnapshot reference/i);
    }
  });

  it('rejects missing and cross-ticker Evidence and restores selected Evidence in source order', async () => {
    const snapshot = { snapshotId: 'snapshot-source', executionId: execution.id, subject: { ticker: 'BBCA' }, fingerprint: 'f'.repeat(64), materializedEvidenceIds: [evidenceId] };
    const manifest = { snapshotId: snapshot.snapshotId, snapshotFingerprint: snapshot.fingerprint, evidenceIds: [evidenceId], marketEvidenceIds: [], newsEvidenceIds: [], marketAvailable: false, newsAvailable: false } as unknown as JsonValue;
    const output = createOutput('collect-sources', manifest);
    const missing = createStores([], { snapshots: new Map([[snapshot.snapshotId, snapshot]]) });
    await expect(decodeJudgeCheckpoint('collect-sources', output, missing.stores, execution)).rejects.toThrow(/missing Evidence/i);

    const foreignTicker = createStores([], { snapshots: new Map([[snapshot.snapshotId, snapshot]]), evidence: [{ ...evidence, ticker: 'BBRI' }] });
    await expect(decodeJudgeCheckpoint('collect-sources', output, foreignTicker.stores, execution)).rejects.toThrow(/outside the canonical Execution/i);

    const selected = createOutput('select-supporting-evidence', { evidenceIds: [evidenceId], marketAvailable: false, newsAvailable: false });
    const restored = await decodeJudgeCheckpoint('select-supporting-evidence', selected, createStores([], { evidence: [evidence] }).stores, execution) as { evidence: unknown[]; evidenceZone: string };
    expect(restored.evidence).toEqual([evidence]);
    expect(restored.evidenceZone).toBe(`Ticker: BBCA\n\n[Evidence 1] test-source (${evidenceId})\n{"metric":1}`);
  });

  it('restores Bull model audit and result metadata', async () => {
    const response = { reasoning: 'A sufficiently detailed reasoning summary.', claims: [validClaim], evidenceIds: [evidenceId], messageId: 'message-bull' };
    const output = createOutput('round-1-bull-thesis', { response, claims: [validClaim], audit: { ...validAudit, contextSnapshotId: null } } as unknown as JsonValue);
    const restored = await decodeJudgeCheckpoint('round-1-bull-thesis', output, createStores().stores, execution) as { response: { messageId: string }; claims: unknown[]; result: Record<string, unknown> };
    expect(restored.response.messageId).toBe('message-bull');
    expect(restored.claims).toEqual([validClaim]);
    expect(restored.result).toMatchObject({ subagent: 'bull', skills: [], value: response });
  });

  it('restores current grounded and historical Bear checkpoints, and rejects mixed representations', async () => {
    const proposal = {
      targetClaimId: 'claim_1',
      argument: 'This evidence weakens the claim.',
      strength: 'moderate',
      evidenceIds: [evidenceId],
      evidenceLinks: [{ evidenceId, relation: 'qualifies', rationale: 'The observation limits the conclusion.' }],
    };
    const grounded = {
      ...proposal,
      counterpointId: 'counterpoint:round-1-bear-challenge:1',
      sourceNodeId: 'round-1-bear-challenge',
      policyId: COUNTERPOINT_POLICY_ID,
      policyFingerprint: COUNTERPOINT_POLICY_FINGERPRINT,
    };
    const currentResponse = { reasoning: 'A sufficiently detailed Bear response.', counterpoints: [proposal], evidenceIds: [evidenceId], messageId: 'message-bear' };
    const currentOutput = createOutput('round-1-bear-challenge', { response: currentResponse, counterpoints: [grounded], audit: { subagent: 'bear', skills: [] } } as unknown as JsonValue);
    const current = await decodeJudgeCheckpoint('round-1-bear-challenge', currentOutput, createStores().stores, execution) as { response: unknown; counterpoints: Array<Record<string, unknown>> };
    expect(current.response).toEqual(currentResponse);
    expect(current.counterpoints).toEqual([grounded]);

    const historicalPoint = { targetClaimId: 'claim_1', argument: 'Historical challenge content.', strength: 'moderate' };
    const historicalResponse = { reasoning: 'A sufficiently detailed historical response.', counterpoints: [historicalPoint], evidenceIds: [evidenceId], messageId: 'message-old' };
    const historicalOutput = createOutput('round-1-bear-challenge', { response: historicalResponse, counterpoints: [historicalPoint], audit: { subagent: 'bear', skills: [] } } as unknown as JsonValue);
    const historical = await decodeJudgeCheckpoint('round-1-bear-challenge', historicalOutput, createStores().stores, execution) as { response: unknown; counterpoints: Array<Record<string, unknown>> };
    expect(historical.response).toEqual(historicalResponse);
    expect(historical.counterpoints).toEqual([historicalPoint]);
    expect(historical.counterpoints[0]).not.toHaveProperty('evidenceLinks');

    const mixed = createOutput('round-1-bear-challenge', { response: currentResponse, counterpoints: [historicalPoint], audit: { subagent: 'bear', skills: [] } } as unknown as JsonValue);
    await expect(decodeJudgeCheckpoint('round-1-bear-challenge', mixed, createStores().stores, execution)).rejects.toThrow();
  });

  it('validates evaluation ticker and accepts only verdict rounds one or two', async () => {
    const evaluation = createOutput('evaluate-arguments', { judgment: { ...validJudgment, ticker: 'BBRI' }, allClaims: [], needsExtra: false, audit: validAudit } as unknown as JsonValue);
    await expect(decodeJudgeCheckpoint('evaluate-arguments', evaluation, createStores().stores, execution)).rejects.toThrow(/invalid evaluation payload/i);

    const invalidVerdict = createOutput('synthesize-verdict', { judgment: validJudgment, rounds: 3 } as unknown as JsonValue);
    await expect(decodeJudgeCheckpoint('synthesize-verdict', invalidVerdict, createStores().stores, execution)).rejects.toThrow(/invalid verdict payload/i);
    const validVerdict = createOutput('synthesize-verdict', { judgment: validJudgment, rounds: 2 } as unknown as JsonValue);
    await expect(decodeJudgeCheckpoint('synthesize-verdict', validVerdict, createStores().stores, execution)).resolves.toMatchObject({ rounds: 2, judgment: validJudgment });
  });

  it('has no CLI, database, or host presentation dependency', () => {
    const source = readFileSync(new URL('../src/judge/checkpointResume.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:from|import)\s+['"][^'"]*(?:apps\/cli|\.\.\/apps|@harness\/database|packages\/database)/i);
    expect(source).not.toMatch(/\b(?:FinharnessDatabase|openDb|HarnessContext|AgentEvent|ConversationController)\b/);
  });
});
