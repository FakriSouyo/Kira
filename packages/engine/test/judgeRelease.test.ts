import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createCapabilityPlan } from '@harness/capability';
import {
  checkpointKindForNode,
  createJudgeExecutionProfile,
  createJudgeWorkflow,
  judgeWorkflowGraphFingerprint,
  type JudgeExecutionProfile,
  type JudgeNodeId,
} from '@harness/command-judge';
import {
  buildClaimGraph,
  CLAIM_POLICY_FINGERPRINT,
  CLAIM_POLICY_ID,
  COUNTERPOINT_POLICY_FINGERPRINT,
  COUNTERPOINT_POLICY_ID,
  type ClaimGraph,
  type ClaimGraphReleaseReceipt,
  type StoredClaim,
  type StoredCounterpoint,
} from '@harness/execution';
import {
  createWorkflowNodeOutput,
  type ExecutionProfile,
  type JsonValue,
  type ResearchExecution,
  type WorkflowNodeOutput,
} from '@harness/session-core';
import type { ArtifactEnvelope } from '@harness/schemas';
import {
  prepareJudgeReleasePlan,
  publishJudgeRelease,
  workflowDependencyFingerprint,
  type JudgeReleasePlan,
  type JudgeReleaseStores,
} from '@harness/engine';

const CREATED_AT = '2026-09-26T00:00:00.000Z';
const COMPLETED_AT = '2026-09-26T00:01:00.000Z';
const EVIDENCE_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_ID = 'snapshot-judge-release';
const TICKER = 'BBCA';
const definition = createJudgeWorkflow();
const capabilityPlan = createCapabilityPlan({ list: () => [] }, []);

function makeExecution(): ResearchExecution {
  return {
    id: 'execution-judge-release',
    sessionId: 'session-judge-release',
    turnId: 'turn-judge-release',
    attempt: 1,
    ticker: TICKER,
    command: 'judge',
    status: 'running',
    executionTime: null,
    error: null,
    createdAt: CREATED_AT,
    completedAt: null,
    resumeGeneration: 1,
  };
}

function makeProfile(execution: ResearchExecution, options: { conditional?: boolean } = {}): JudgeExecutionProfile {
  return createJudgeExecutionProfile({
    executionId: execution.id,
    ticker: execution.ticker,
    reasoningMode: 'usual',
    conditional: options.conditional ?? false,
    researchers: { market: false, news: false },
    provider: 'test-provider',
    model: 'test-model',
    capabilityPlan,
    createdAt: execution.createdAt,
  });
}

function groundedClaim(claimId: string) {
  return {
    claimId,
    statement: `The company has durable support for ${claimId}.`,
    confidence: 'moderate' as const,
    reasoning: 'The verified source supports this conclusion within the reviewed period.',
    evidenceIds: [EVIDENCE_ID],
    evidenceLinks: [{
      evidenceId: EVIDENCE_ID,
      relation: 'supports' as const,
      rationale: 'The accepted financial observation supports the claim.',
    }],
    policyId: CLAIM_POLICY_ID,
    policyFingerprint: CLAIM_POLICY_FINGERPRINT,
  };
}

function storedClaim(claim: ReturnType<typeof groundedClaim>, messageId: string, executionId: string): StoredClaim {
  return {
    id: `stored-${claim.claimId}`,
    runId: executionId,
    messageId,
    ...claim,
    createdAt: CREATED_AT,
  };
}

function groundedCounterpoint(nodeId: 'round-1-bear-challenge' | 'conditional-bear-rechallenge', index: number, targetClaimId: string) {
  return {
    counterpointId: `counterpoint:${nodeId}:${index}`,
    sourceNodeId: nodeId,
    targetClaimId,
    argument: 'The observed result may not persist beyond the reviewed period.',
    strength: 'moderate' as const,
    evidenceIds: [EVIDENCE_ID],
    evidenceLinks: [{
      evidenceId: EVIDENCE_ID,
      relation: 'qualifies' as const,
      rationale: 'The observation has limited period coverage.',
    }],
    policyId: COUNTERPOINT_POLICY_ID,
    policyFingerprint: COUNTERPOINT_POLICY_FINGERPRINT,
  };
}

function storedCounterpoint(
  counterpoint: ReturnType<typeof groundedCounterpoint>,
  messageId: string,
  executionId: string,
): StoredCounterpoint {
  return {
    id: `stored-${counterpoint.counterpointId}`,
    runId: executionId,
    messageId,
    ...counterpoint,
    createdAt: CREATED_AT,
  };
}

function audit(subagent: string) {
  return { subagent, skills: [] };
}

function bullCheckpoint(claim: ReturnType<typeof groundedClaim>, messageId: string): JsonValue {
  const response = {
    reasoning: 'The accepted financial evidence supports a measured operating thesis.',
    claims: [claim],
    evidenceIds: [EVIDENCE_ID],
    messageId,
  };
  return { response, claims: [claim], audit: audit('bull') } as unknown as JsonValue;
}

function bearCheckpoint(
  nodeId: 'round-1-bear-challenge' | 'conditional-bear-rechallenge',
  messageId: string,
  counterpoints: readonly ReturnType<typeof groundedCounterpoint>[],
): JsonValue {
  const proposals = counterpoints.map(counterpoint => {
    const {
      counterpointId: _counterpointId,
      sourceNodeId: _sourceNodeId,
      policyId: _policyId,
      policyFingerprint: _policyFingerprint,
      ...proposal
    } = counterpoint;
    return proposal;
  });
  return {
    response: {
      reasoning: 'A material risk still qualifies the bullish conclusion.',
      counterpoints: proposals,
      evidenceIds: [EVIDENCE_ID],
      messageId,
    },
    counterpoints,
    audit: audit('bear'),
  } as unknown as JsonValue;
}

function judgment() {
  return {
    ticker: TICKER,
    score: 70,
    stance: 'bullish' as const,
    confidence: 'moderate' as const,
    breakdown: { financialHealth: 70, growth: 70, valuation: 70, marketMomentum: null, risk: null },
    summary: 'Verified evidence supports a measured positive outlook.',
  };
}

type CheckpointValue = { status: 'completed' | 'skipped'; payload: JsonValue | null };
type Harness = ReturnType<typeof createHarness>;

function createHarness(options: {
  conditional?: boolean;
  duplicateCheckpointClaimId?: boolean;
  duplicateCheckpointCounterpointId?: boolean;
} = {}) {
  const conditional = options.conditional ?? false;
  const execution = makeExecution();
  const profile = makeProfile(execution, { conditional });
  const firstClaim = groundedClaim('claim-thesis-1');
  const rebuttalClaim = groundedClaim('claim-rebuttal-1');
  const conditionalClaim = conditional ? groundedClaim('claim-conditional-1') : undefined;
  const firstCounterpoint = groundedCounterpoint('round-1-bear-challenge', 1, firstClaim.claimId);
  const conditionalCounterpoint = conditional && conditionalClaim
    ? groundedCounterpoint('conditional-bear-rechallenge', 1, conditionalClaim.claimId)
    : undefined;
  const storedClaims = [
    storedClaim(firstClaim, 'message-bull-thesis', execution.id),
    storedClaim(rebuttalClaim, 'message-bull-rebuttal', execution.id),
    ...(conditionalClaim ? [storedClaim(conditionalClaim, 'message-bull-extra_conditional', execution.id)] : []),
  ];
  const storedCounterpoints = [
    storedCounterpoint(firstCounterpoint, 'message-bear-round-one', execution.id),
    ...(conditionalCounterpoint ? [storedCounterpoint(conditionalCounterpoint, 'message-bear-extra_conditional', execution.id)] : []),
  ];
  const checkpointRebuttalClaim = options.duplicateCheckpointClaimId
    ? { ...rebuttalClaim, claimId: firstClaim.claimId }
    : rebuttalClaim;
  const checkpointRoundOneCounterpoints = options.duplicateCheckpointCounterpointId
    ? [firstCounterpoint, firstCounterpoint]
    : [firstCounterpoint];

  const dataMetadata = {
    providerId: 'test-provider',
    source: 'test.financial-data',
    origin: 'MOCK' as const,
    fetchedAt: CREATED_AT,
    dataAsOf: null,
    requestedAsOf: null,
    period: null,
    derivedFrom: [],
  };
  const snapshot = {
    snapshotId: SNAPSHOT_ID,
    executionId: execution.id,
    subject: { ticker: TICKER },
    fingerprint: 'f'.repeat(64),
    materializedEvidenceIds: [EVIDENCE_ID],
  };
  const evidence = {
    id: EVIDENCE_ID,
    ticker: TICKER,
    source: 'test.financial-data',
    data: { metric: 1 },
  };

  const payloads = new Map<JudgeNodeId, CheckpointValue>();
  const completed = (payload: unknown): CheckpointValue => ({ status: 'completed', payload: payload as JsonValue });
  const skipped: CheckpointValue = { status: 'skipped', payload: null };
  payloads.set('identify-company', completed({
    data: { ticker: TICKER, financials: {}, valuation: {} },
    metadata: dataMetadata,
  }));
  payloads.set('fetch-financials', completed({
    data: { ticker: TICKER, quarters: [{ period: '2026-Q2', revenue: 100, netIncome: 10 }] },
    metadata: dataMetadata,
  }));
  payloads.set('fetch-market-data', skipped);
  payloads.set('fetch-news', skipped);
  payloads.set('collect-sources', completed({
    snapshotId: SNAPSHOT_ID,
    snapshotFingerprint: snapshot.fingerprint,
    evidenceIds: [EVIDENCE_ID],
    marketEvidenceIds: [],
    newsEvidenceIds: [],
    marketAvailable: false,
    newsAvailable: false,
  }));
  payloads.set('select-supporting-evidence', completed({
    evidenceIds: [EVIDENCE_ID],
    marketAvailable: false,
    newsAvailable: false,
  }));
  payloads.set('round-1-bull-thesis', completed(bullCheckpoint(firstClaim, 'message-bull-thesis')));
  payloads.set('round-1-bear-challenge', completed(bearCheckpoint('round-1-bear-challenge', 'message-bear-round-one', checkpointRoundOneCounterpoints)));
  payloads.set('round-2-bull-rebuttal', completed(bullCheckpoint(checkpointRebuttalClaim, 'message-bull-rebuttal')));
  payloads.set('evaluate-arguments', completed({
    judgment: judgment(),
    allClaims: [],
    needsExtra: conditional,
    audit: audit('judge'),
  }));
  payloads.set('conditional-bear-rechallenge', conditionalCounterpoint && conditionalClaim
    ? completed(bearCheckpoint('conditional-bear-rechallenge', 'message-bear-extra', [conditionalCounterpoint]))
    : skipped);
  payloads.set('conditional-bull-rebuttal', conditionalClaim
    ? completed(bullCheckpoint(conditionalClaim, 'message-bull-extra'))
    : skipped);
  payloads.set('resolve-conflicts', conditional
    ? completed({
      judgment: judgment(),
      allClaims: [firstClaim, rebuttalClaim, conditionalClaim],
      needsExtra: false,
      audit: audit('judge'),
    })
    : skipped);
  payloads.set('check-evidence', completed({
    claims: storedClaims.length,
    challenges: storedCounterpoints.length,
    evidenceIds: [EVIDENCE_ID],
    audit: audit('judge'),
  }));
  payloads.set('synthesize-verdict', completed({
    judgment: judgment(),
    rounds: conditional ? 2 : 1,
  }));

  const outputs: WorkflowNodeOutput[] = [];
  const fingerprints = new Map<string, string>();
  for (const node of definition.nodes) {
    const checkpoint = payloads.get(node.id as JudgeNodeId);
    if (!checkpoint) throw new Error(`Test fixture omitted ${node.id}`);
    const output = createWorkflowNodeOutput({
      executionId: execution.id,
      workflowId: profile.workflowId,
      workflowVersion: profile.workflowVersion,
      nodeId: node.id,
      status: checkpoint.status,
      outputKind: checkpointKindForNode(node.id as JudgeNodeId),
      dependencyFingerprint: workflowDependencyFingerprint(node, fingerprints, profile.fingerprint),
      payload: checkpoint.payload,
      completionGeneration: execution.resumeGeneration,
      createdAt: CREATED_AT,
    });
    outputs.push(output);
    fingerprints.set(node.id, output.outputFingerprint);
  }

  let graphOverride: ClaimGraph | undefined;
  const artifactWrites = vi.fn(async (artifacts: readonly ArtifactEnvelope[]) => [...artifacts]);
  const receiptWrites = vi.fn(async (receipt: ClaimGraphReleaseReceipt) => receipt);
  const stores: JudgeReleaseStores = {
    workflowNodeOutputs: {
      async listNodeOutputsForExecution<TPayload extends JsonValue = JsonValue>(executionId: string) {
        return outputs.filter(output => output.executionId === executionId) as WorkflowNodeOutput<TPayload>[];
      },
    },
    financialSnapshots: { getById: async snapshotId => snapshotId === snapshot.snapshotId ? snapshot as never : null },
    evidence: {
      getManyByIdsForRun: async (_executionId, ids) => ids.flatMap(id => id === evidence.id ? [evidence as never] : []),
    },
    contextSnapshots: { getById: async () => null },
    claims: { getByRun: async executionId => storedClaims.filter(claim => claim.runId === executionId) },
    counterpoints: { getByRun: async executionId => storedCounterpoints.filter(point => point.runId === executionId) },
    claimGraph: {
      getByExecution: async executionId => graphOverride
        ?? buildClaimGraph({ executionId, claims: storedClaims, counterpoints: storedCounterpoints }),
    },
    artifacts: { saveMany: artifactWrites },
    claimGraphReleases: { save: receiptWrites },
  };

  return {
    execution,
    profile,
    outputs,
    storedClaims,
    storedCounterpoints,
    stores,
    artifactWrites,
    receiptWrites,
    overrideGraph(graph: ClaimGraph) { graphOverride = graph; },
  };
}

function prepare(harness: Harness) {
  return prepareJudgeReleasePlan({
    stores: harness.stores,
    execution: harness.execution,
    profile: harness.profile,
  });
}

describe('host-neutral Judge current release core', () => {
  it('prepares a complete current release and preserves the artifact graph projections', async () => {
    const harness = createHarness({ conditional: true });
    const plan = await prepare(harness);

    expect(plan.graph.executionId).toBe(harness.execution.id);
    expect(plan.graph.nodes).toHaveLength(5);
    expect(plan.graph.edges).toHaveLength(2);
    expect(plan.artifactProjections.map(projection => projection.kind)).toEqual(['BULL_CASE', 'BEAR_CASE', 'VERDICT']);

    const [bull, bear, verdict] = plan.artifactProjections;
    expect(bull?.nodes.filter(node => node.kind === 'claim').map(node => node.claimId)).toEqual([
      'claim-rebuttal-1',
      'claim-thesis-1',
    ]);
    expect(bull?.edges).toEqual([]);
    expect(bear?.edges).toHaveLength(1);
    expect(bear?.nodes.some(node => node.kind === 'counterpoint' && node.counterpointId.includes('conditional'))).toBe(false);
    expect(verdict?.nodes).toEqual(plan.graph.nodes);
    expect(verdict?.edges).toEqual(plan.graph.edges);
    expect(plan.contents.claimIds).toEqual(harness.storedClaims.map(claim => claim.claimId));

  });

  it('publishes exactly three artifacts and one immutable receipt after a completed Execution', async () => {
    const harness = createHarness();
    const plan = await prepare(harness);
    const completedExecution: ResearchExecution = {
      ...harness.execution,
      status: 'completed',
      completedAt: COMPLETED_AT,
      executionTime: 60,
    };

    const published = await publishJudgeRelease({
      stores: harness.stores,
      execution: completedExecution,
      profile: harness.profile,
      plan,
    });

    expect(published.artifacts.map(artifact => artifact.kind)).toEqual(['BULL_CASE', 'BEAR_CASE', 'VERDICT']);
    expect(published.artifacts.map(artifact => artifact.artifactId)).toEqual([
      `artifact_bull_case_${completedExecution.id}`,
      `artifact_bear_case_${completedExecution.id}`,
      `artifact_verdict_${completedExecution.id}`,
    ]);
    expect(published.artifacts[2]?.payload).toMatchObject({
      evidenceIds: [EVIDENCE_ID],
      claimIds: harness.storedClaims.map(claim => claim.claimId),
      rounds: 1,
    });
    expect(published.artifacts[0]?.payload).toMatchObject({
      thesis: { messageId: 'message-bull-thesis', claims: [{ claimId: 'claim-thesis-1' }] },
      rebuttal: { messageId: 'message-bull-rebuttal', claims: [{ claimId: 'claim-rebuttal-1' }] },
    });
    expect(published.artifacts[1]?.payload).toMatchObject({
      messageId: 'message-bear-round-one',
      counterpoints: [{ counterpointId: 'counterpoint:round-1-bear-challenge:1' }],
    });
    expect(published.receipt.artifactProjections.map(projection => projection.kind)).toEqual(['BULL_CASE', 'BEAR_CASE', 'VERDICT']);
    expect(published.receipt.artifactProjections[2]?.nodes).toEqual(plan.graph.nodes);
    expect(published.receipt.artifactProjections[2]?.edges).toEqual(plan.graph.edges);
    expect(Object.isFrozen(published.receipt)).toBe(true);
    expect(Object.isFrozen(published.receipt.artifactProjections)).toBe(true);
    expect(harness.artifactWrites).toHaveBeenCalledTimes(1);
    expect(harness.receiptWrites).toHaveBeenCalledTimes(1);
    expect(harness.artifactWrites.mock.invocationCallOrder[0]).toBeLessThan(harness.receiptWrites.mock.invocationCallOrder[0]!);
  });

  it('rejects a missing output from the final current checkpoint set', async () => {
    const harness = createHarness();
    harness.outputs.pop();
    await expect(prepare(harness)).rejects.toThrow(/complete final Judge checkpoint set/i);
  });

  it('fails closed for missing, unexpected, semantically changed, or Policy-drifted Claims', async () => {
    const corruptions: Array<[string, (harness: Harness) => void]> = [
      ['missing Claim', harness => { harness.storedClaims.splice(0, 1); }],
      ['unexpected Claim', harness => { harness.storedClaims.push(storedClaim(groundedClaim('claim-unexpected'), 'message-unexpected', harness.execution.id)); }],
      ['semantic Claim drift', harness => { harness.storedClaims[0]!.statement = 'A different but valid stored Claim statement.'; }],
      ['Claim Policy ID drift', harness => { harness.storedClaims[0]!.policyId = 'claim-policy-legacy'; }],
      ['Claim Policy fingerprint drift', harness => { harness.storedClaims[0]!.policyFingerprint = '0'.repeat(64); }],
    ];
    for (const [label, corrupt] of corruptions) {
      const harness = createHarness();
      corrupt(harness);
      await expect(prepare(harness), label).rejects.toThrow();
    }
  });

  it('fails closed for missing, unexpected, semantically changed, or Policy-drifted Counterpoints', async () => {
    const corruptions: Array<[string, (harness: Harness) => void]> = [
      ['missing Counterpoint', harness => { harness.storedCounterpoints.splice(0, 1); }],
      ['unexpected Counterpoint', harness => {
        const extra = groundedCounterpoint('round-1-bear-challenge', 2, 'claim-thesis-1');
        harness.storedCounterpoints.push(storedCounterpoint(extra, 'message-bear-round-one', harness.execution.id));
      }],
      ['semantic Counterpoint drift', harness => { harness.storedCounterpoints[0]!.argument = 'A different but valid stored counterpoint argument.'; }],
      ['Counterpoint Policy ID drift', harness => { harness.storedCounterpoints[0]!.policyId = 'counterpoint-policy-legacy'; }],
      ['Counterpoint Policy fingerprint drift', harness => { harness.storedCounterpoints[0]!.policyFingerprint = '0'.repeat(64); }],
    ];
    for (const [label, corrupt] of corruptions) {
      const harness = createHarness();
      corrupt(harness);
      await expect(prepare(harness), label).rejects.toThrow();
    }
  });

  it('rejects duplicate Claim and Counterpoint identities in completed checkpoints', async () => {
    await expect(prepare(createHarness({ duplicateCheckpointClaimId: true }))).rejects.toThrow(/duplicate Claim/i);
    await expect(prepare(createHarness({ duplicateCheckpointCounterpointId: true }))).rejects.toThrow(/Counterpoint identity or Policy/i);
  });

  it('rejects a Claim Graph reader that disagrees with the durable Claim and Counterpoint stores', async () => {
    const harness = createHarness();
    harness.overrideGraph({ executionId: harness.execution.id, nodes: [], edges: [] });
    await expect(prepare(harness)).rejects.toThrow(/Claim Graph reader disagrees/i);
  });

  it('rejects publication for invalid lifecycle identity and non-current release profiles', async () => {
    const harness = createHarness();
    const plan: JudgeReleasePlan = await prepare(harness);
    const completedExecution: ResearchExecution = {
      ...harness.execution,
      status: 'completed',
      completedAt: COMPLETED_AT,
      executionTime: 60,
    };
    const legacyPayload = Object.fromEntries(Object.entries(harness.profile.payload)
      .filter(([key]) => key !== 'releaseContract' && key !== 'releaseContractFingerprint'));
    const legacyProfile = {
      ...harness.profile,
      payload: legacyPayload as JsonValue,
    } as ExecutionProfile;
    const unsupportedProfile = {
      ...harness.profile,
      payload: { ...harness.profile.payload, releaseContractFingerprint: '0'.repeat(64) },
    } as ExecutionProfile;
    const mismatchedProfileExecution = {
      ...harness.profile,
      executionId: 'execution-other',
    } as ExecutionProfile;
    const alternateProfile = createJudgeExecutionProfile({
      executionId: harness.execution.id,
      ticker: harness.execution.ticker,
      reasoningMode: 'usual',
      conditional: false,
      researchers: { market: false, news: false },
      provider: 'test-provider',
      model: 'different-model',
      capabilityPlan,
      createdAt: harness.execution.createdAt,
    });
    const invalidCases: Array<[string, ResearchExecution, ExecutionProfile]> = [
      ['non-completed Execution', { ...completedExecution, status: 'running' }, harness.profile],
      ['missing completedAt', { ...completedExecution, completedAt: null }, harness.profile],
      ['wrong execution ID', { ...completedExecution, id: 'execution-other' }, harness.profile],
      ['wrong profile fingerprint', completedExecution, alternateProfile],
      ['wrong profile execution ID', completedExecution, mismatchedProfileExecution],
      ['legacy release profile', completedExecution, legacyProfile],
      ['unsupported release profile', completedExecution, unsupportedProfile],
    ];

    for (const [label, execution, profile] of invalidCases) {
      await expect(publishJudgeRelease({
        stores: harness.stores,
        execution,
        profile,
        plan,
      }), label).rejects.toThrow();
    }
    expect(harness.artifactWrites).not.toHaveBeenCalled();
    expect(harness.receiptWrites).not.toHaveBeenCalled();
  });

  it('keeps current release construction independent of CLI and database modules', () => {
    const source = readFileSync(new URL('../src/judge/release.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:from|import)\s+['"][^'"]*(?:apps\/cli|\.\.\/apps|@harness\/database|packages\/database)/i);
    expect(source).not.toMatch(/\b(?:FinharnessDatabase|openDb|HarnessContext|AgentEvent|ConversationController)\b/);
  });
});
