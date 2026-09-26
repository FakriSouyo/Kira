import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLAIM_POLICY_FINGERPRINT,
  CLAIM_POLICY_ID,
  COUNTERPOINT_POLICY_FINGERPRINT,
  COUNTERPOINT_POLICY_ID,
  type GroundedClaim,
} from '@harness/execution';
import type { GroundedCounterpoint, Judgment } from '@harness/schemas';
import type {
  JsonValue,
  ModelCallRecord,
  ResearchExecution,
  WorkflowNodeOutput,
  WorkflowStepRecord,
} from '@harness/session-core';
import { repairJudgeProjections, type JudgeProjectionRepairStores } from '@harness/engine';

const EXECUTION_ID = 'execution-projection-repair';
const EVIDENCE_ONE = '00000000-0000-4000-8000-000000000001';
const EVIDENCE_TWO = '00000000-0000-4000-8000-000000000002';
const execution: ResearchExecution = {
  id: EXECUTION_ID,
  sessionId: 'session-projection-repair',
  turnId: 'turn-projection-repair',
  attempt: 1,
  ticker: 'BBCA',
  command: 'judge',
  status: 'interrupted',
  executionTime: null,
  error: null,
  createdAt: '2026-09-26T00:00:00.000Z',
  completedAt: null,
  resumeGeneration: 1,
};

type AddMessage = Parameters<JudgeProjectionRepairStores['conversation']['addMessage']>[0];
type SaveStep = Parameters<JudgeProjectionRepairStores['trace']['saveStep']>[0];
type RecordModelCall = Parameters<JudgeProjectionRepairStores['trace']['recordModelCall']>[0];
type SaveClaim = Parameters<JudgeProjectionRepairStores['claims']['save']>[0];
type RepairLegacyClaim = Parameters<JudgeProjectionRepairStores['claims']['repairLegacyCheckpointProjection']>[0];
type SaveCounterpoint = Parameters<JudgeProjectionRepairStores['counterpoints']['save']>[0];
type SaveJudgment = Parameters<JudgeProjectionRepairStores['judgments']['save']>[0];

function stepKey(runId: string, nodeId: string): string {
  return `${runId}/${nodeId}`;
}

function createHarness(options: {
  steps?: WorkflowStepRecord[];
  modelCalls?: ModelCallRecord[];
} = {}) {
  const messages: AddMessage[] = [];
  const steps = new Map((options.steps ?? []).map(step => [stepKey(step.runId, step.nodeId), step]));
  const modelCalls = [...(options.modelCalls ?? [])];
  const currentClaims: SaveClaim[] = [];
  const legacyClaims: RepairLegacyClaim[] = [];
  const counterpoints: SaveCounterpoint[] = [];
  const judgments = new Map<string, SaveJudgment>();
  const writes = {
    steps: [] as SaveStep[],
    modelCalls: [] as RecordModelCall[],
  };

  const stores: JudgeProjectionRepairStores = {
    trace: {
      getStep: async (runId, nodeId) => steps.get(stepKey(runId, nodeId)) ?? null,
      saveStep: async params => {
        writes.steps.push(params);
        const record: WorkflowStepRecord = {
          id: params.stepId ?? `step_${params.runId}_${params.nodeId}`,
          runId: params.runId,
          nodeId: params.nodeId,
          parentNodeIds: params.parentNodeIds,
          subagent: params.subagent ?? null,
          skills: params.skills,
          status: params.status,
          durationMs: params.durationMs ?? null,
          summary: params.summary ?? null,
          error: params.error ?? null,
          createdAt: execution.createdAt,
          completedAt: params.status === 'completed' || params.status === 'failed' || params.status === 'skipped'
            ? '2026-09-26T00:01:00.000Z'
            : null,
        };
        steps.set(stepKey(params.runId, params.nodeId), record);
        return record;
      },
      listModelCallsForStep: async (runId, stepId) => modelCalls.filter(call => call.runId === runId && call.stepId === stepId),
      recordModelCall: async params => {
        writes.modelCalls.push(params);
        const record: ModelCallRecord = {
          id: params.callId ?? `call_${modelCalls.length + 1}`,
          runId: params.runId ?? null,
          turnId: params.turnId ?? null,
          stepId: params.stepId ?? null,
          subagent: params.subagent,
          provider: params.provider,
          model: params.model,
          providerId: params.providerId ?? null,
          modelId: params.modelId ?? null,
          adapterId: params.adapterId ?? null,
          protocol: params.protocol ?? null,
          runtimeFingerprint: params.runtimeFingerprint ?? null,
          attempt: params.attempt,
          inputTokens: params.inputTokens,
          outputTokens: params.outputTokens,
          cachedInputTokens: params.cachedInputTokens,
          totalTokens: params.totalTokens,
          cost: params.cost,
          currency: params.currency,
          latencyMs: params.latencyMs,
          finishReason: params.finishReason,
          contextSnapshotId: params.contextSnapshotId ?? null,
          createdAt: '2026-09-26T00:01:00.000Z',
        };
        modelCalls.push(record);
        return record;
      },
    },
    conversation: {
      addMessage: async message => {
        const existing = messages.find(item => item.runId === message.runId && item.messageId === message.messageId);
        if (!existing) messages.push(message);
      },
    },
    claims: {
      save: async params => {
        if (!currentClaims.some(item => item.runId === params.runId && item.claim.claimId === params.claim.claimId)) currentClaims.push(params);
        return {} as never;
      },
      repairLegacyCheckpointProjection: async params => {
        if (!legacyClaims.some(item => item.runId === params.runId && item.claim.claimId === params.claim.claimId)) legacyClaims.push(params);
        return {} as never;
      },
    },
    counterpoints: {
      save: async params => {
        if (!counterpoints.some(item => item.runId === params.runId && item.counterpoint.counterpointId === params.counterpoint.counterpointId)) {
          counterpoints.push(params);
        }
        return {} as never;
      },
    },
    judgments: {
      save: async params => {
        judgments.set(params.runId, params);
        return {} as never;
      },
    },
  };

  return { stores, messages, steps, modelCalls, currentClaims, legacyClaims, counterpoints, judgments, writes };
}

function output(
  nodeId: string,
  status: 'completed' | 'skipped' = 'completed',
  payload: unknown | null = {},
): WorkflowNodeOutput {
  return {
    outputId: `output_${nodeId}`,
    schemaVersion: 1,
    executionId: EXECUTION_ID,
    workflowId: 'judge',
    workflowVersion: 2,
    nodeId,
    status,
    outputKind: `judge.${nodeId}.v1`,
    dependencyFingerprint: 'dependency-fingerprint',
    outputFingerprint: 'output-fingerprint',
    payload: payload as JsonValue | null,
    completionGeneration: 1,
    createdAt: '2026-09-26T00:01:00.000Z',
  };
}

function selectionOutput(evidenceIds: string[] = [EVIDENCE_ONE]): WorkflowNodeOutput {
  return output('select-supporting-evidence', 'completed', {
    evidenceIds,
    marketAvailable: true,
    newsAvailable: false,
  });
}

function sourceOutput(evidenceIds: string[] = [EVIDENCE_ONE]): WorkflowNodeOutput {
  return output('collect-sources', 'completed', {
    snapshotId: 'snapshot-1',
    snapshotFingerprint: 'snapshot-fingerprint',
    evidenceIds,
    marketEvidenceIds: [],
    newsEvidenceIds: [],
    marketAvailable: true,
    newsAvailable: false,
  });
}

function groundedClaim(): GroundedClaim {
  return {
    claimId: 'claim_1',
    statement: 'The company has a durable growth outlook.',
    confidence: 'moderate',
    reasoning: 'Revenue growth and healthy margins support this view.',
    evidenceIds: [EVIDENCE_ONE],
    evidenceLinks: [{ evidenceId: EVIDENCE_ONE, relation: 'supports', rationale: 'This Evidence supports the claim.' }],
    policyId: CLAIM_POLICY_ID,
    policyFingerprint: CLAIM_POLICY_FINGERPRINT,
  };
}

function historicalClaim(): Omit<GroundedClaim, 'evidenceLinks' | 'policyId' | 'policyFingerprint'> {
  const { evidenceLinks: _links, policyId: _policyId, policyFingerprint: _fingerprint, ...claim } = groundedClaim();
  return claim;
}

function modelAudit() {
  return {
    subagent: 'bull',
    skills: [{ name: 'bull-analysis', contentHash: 'sha256:bull-skill' }],
    contextSnapshotId: 'context-snapshot-1',
    modelCall: {
      provider: 'mock-provider',
      model: 'mock-model',
      providerId: 'provider-id',
      modelId: 'model-id',
      adapterId: 'openai-compatible',
      protocol: 'responses',
      runtimeFingerprint: 'runtime-fingerprint',
      inputTokens: 11,
      outputTokens: 22,
      cachedInputTokens: 3,
      totalTokens: 33,
      latencyMs: 44,
      finishReason: 'stop',
    },
  };
}

function bullOutput(options: {
  messageId?: string;
  claims?: unknown[];
  evidenceIds?: string[];
  audit?: ReturnType<typeof modelAudit>;
  nodeId?: string;
} = {}): WorkflowNodeOutput {
  return output(options.nodeId ?? 'round-1-bull-thesis', 'completed', {
    response: {
      messageId: options.messageId ?? 'bull-message-1',
      reasoning: 'The Bull reasoning supports a positive long-term view.',
      evidenceIds: options.evidenceIds ?? [EVIDENCE_ONE],
    },
    claims: options.claims ?? [],
    ...(options.audit ? { audit: options.audit } : {}),
  });
}

function historicalBearPayload(options: { messageId?: string; evidenceIds?: string[] } = {}) {
  const counterpoint = {
    targetClaimId: 'claim_1',
    strength: 'high' as const,
    argument: 'The margin trend could reverse quickly.',
  };
  return {
    response: {
      messageId: options.messageId ?? 'bear-message-1',
      reasoning: 'The Bear reasoning challenges the thesis.',
      evidenceIds: options.evidenceIds ?? [EVIDENCE_ONE],
      counterpoints: [counterpoint],
    },
    counterpoints: [counterpoint],
  };
}

function currentBearPayload(options: {
  nodeId?: 'round-1-bear-challenge' | 'conditional-bear-rechallenge';
  messageId?: string;
  responseEvidenceIds?: string[];
  counterpointEvidenceIds?: string[];
} = {}) {
  const nodeId = options.nodeId ?? 'round-1-bear-challenge';
  const evidenceIds = options.counterpointEvidenceIds ?? [EVIDENCE_ONE];
  const proposal = {
    targetClaimId: 'claim_1',
    argument: 'The margin trend could reverse quickly.',
    strength: 'high' as const,
    evidenceIds,
    evidenceLinks: evidenceIds.map(evidenceId => ({
      evidenceId,
      relation: 'qualifies' as const,
      rationale: 'This Evidence qualifies the claim.',
    })),
  };
  const counterpoint: GroundedCounterpoint = {
    ...proposal,
    counterpointId: `counterpoint:${nodeId}:1`,
    sourceNodeId: nodeId,
    policyId: COUNTERPOINT_POLICY_ID,
    policyFingerprint: COUNTERPOINT_POLICY_FINGERPRINT,
  };
  return {
    response: {
      messageId: options.messageId ?? 'bear-message-1',
      reasoning: 'The Bear reasoning challenges the thesis.',
      evidenceIds: options.responseEvidenceIds ?? [EVIDENCE_ONE],
      counterpoints: [proposal],
    },
    counterpoints: [counterpoint],
  };
}

function judgment(): Judgment {
  return {
    ticker: 'BBCA',
    score: 72,
    stance: 'bullish',
    confidence: 'moderate',
    breakdown: { financialHealth: 70, growth: 75, valuation: 65, marketMomentum: null, risk: 40 },
    summary: 'The evidence supports a measured bullish outlook.',
  };
}

describe('Judge resume projection repair', () => {
  it('reconstructs a completed WorkflowStep from a completed output', async () => {
    const harness = createHarness();
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [output('identify-company')] });

    expect(harness.writes.steps[0]).toMatchObject({
      stepId: `step_${EXECUTION_ID}_identify-company`,
      runId: EXECUTION_ID,
      nodeId: 'identify-company',
      status: 'completed',
    });
  });

  it('reconstructs a skipped WorkflowStep from a skipped output', async () => {
    const harness = createHarness();
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [output('fetch-market-data', 'skipped', null)] });

    expect(harness.writes.steps[0]).toMatchObject({ nodeId: 'fetch-market-data', status: 'skipped' });
  });

  it('reconstructs an optional provider failure as a failed WorkflowStep', async () => {
    const harness = createHarness();
    await repairJudgeProjections({
      stores: harness.stores,
      execution,
      outputs: [output('fetch-market-data', 'completed', { outcome: 'optional-failure', errorCode: 'PROVIDER_TIMEOUT' })],
    });

    expect(harness.writes.steps[0]).toMatchObject({ status: 'failed', error: 'PROVIDER_TIMEOUT' });
  });

  it('preserves an existing WorkflowStep ID, duration, and summary when repairing its status', async () => {
    const existing: WorkflowStepRecord = {
      id: 'existing-workflow-step',
      runId: EXECUTION_ID,
      nodeId: 'identify-company',
      parentNodeIds: [],
      subagent: 'researcher',
      skills: [],
      status: 'running',
      durationMs: 321,
      summary: 'Existing durable summary',
      error: null,
      createdAt: execution.createdAt,
      completedAt: null,
    };
    const harness = createHarness({ steps: [existing] });
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [output('identify-company')] });

    expect(harness.writes.steps[0]).toMatchObject({
      stepId: existing.id,
      durationMs: 321,
      summary: 'Existing durable summary',
    });
  });

  it('uses checkpoint audit data to fill missing subagent and skills fields', async () => {
    const harness = createHarness();
    const audit = { subagent: 'bull-audited', skills: [{ name: 'bull-analysis', contentHash: 'sha256:bull-skill' }] };
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [bullOutput({ audit: { ...modelAudit(), ...audit } })] });

    expect(harness.writes.steps[0]).toMatchObject({ subagent: 'bull-audited', skills: audit.skills });
  });

  it('restores the researcher message identity, metadata, and sequence zero', async () => {
    const harness = createHarness();
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [sourceOutput()] });

    expect(harness.messages[0]).toEqual({
      runId: EXECUTION_ID,
      messageId: `researcher_${EXECUTION_ID}`,
      agent: 'researcher',
      messageType: 'observation',
      content: 'I retrieved the evidence for BBCA and stored it for this run.',
      evidenceIds: [EVIDENCE_ONE],
      sequenceOrder: 0,
      metadata: { marketAvailable: true, newsAvailable: false },
    });
  });

  it('restores the Bull message identity, content, metadata, and sequence one', async () => {
    const harness = createHarness();
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [bullOutput()] });

    expect(harness.messages[0]).toMatchObject({
      messageId: 'bull-message-1',
      agent: 'bull',
      messageType: 'claim',
      content: 'The Bull reasoning supports a positive long-term view.',
      sequenceOrder: 1,
      metadata: { claimCount: 0, seenEvidenceIds: [] },
    });
  });

  it('restores Bear content composition, message identity, metadata, and sequence two', async () => {
    const harness = createHarness();
    await repairJudgeProjections({
      stores: harness.stores,
      execution,
      outputs: [output('round-1-bear-challenge', 'completed', historicalBearPayload())],
    });

    expect(harness.messages[0]).toMatchObject({
      messageId: 'bear-message-1',
      agent: 'bear',
      messageType: 'challenge',
      content: 'The Bear reasoning challenges the thesis.\nChallenge #1 (targets claim claim_1, strength high): The margin trend could reverse quickly.',
      sequenceOrder: 2,
      metadata: { challengeCount: 1, seenEvidenceIds: [] },
    });
  });

  it('restores the Judge message identity, content, metadata, and sequence four', async () => {
    const harness = createHarness();
    await repairJudgeProjections({
      stores: harness.stores,
      execution,
      outputs: [output('evaluate-arguments', 'completed', { judgment: judgment() })],
    });

    expect(harness.messages[0]).toMatchObject({
      messageId: `judge_${EXECUTION_ID}`,
      agent: 'judge',
      messageType: 'decision',
      content: judgment().summary,
      sequenceOrder: 4,
      metadata: { score: 72, stance: 'bullish', seenEvidenceIds: [] },
    });
  });

  it('preserves all conditional message suffixes, conditional metadata, and sequence values', async () => {
    const harness = createHarness();
    await repairJudgeProjections({
      stores: harness.stores,
      execution,
      outputs: [
        selectionOutput(),
        output('conditional-bear-rechallenge', 'completed', historicalBearPayload({ messageId: 'bear-conditional' })),
        bullOutput({ nodeId: 'conditional-bull-rebuttal', messageId: 'bull-conditional' }),
        output('resolve-conflicts', 'completed', { judgment: judgment() }),
      ],
    });

    expect(harness.messages.map(({ messageId, sequenceOrder, metadata }) => ({ messageId, sequenceOrder, metadata }))).toEqual([
      { messageId: 'bear-conditional_conditional', sequenceOrder: 5, metadata: { challengeCount: 1, seenEvidenceIds: [EVIDENCE_ONE], conditional: true } },
      { messageId: 'bull-conditional_conditional', sequenceOrder: 6, metadata: { claimCount: 0, seenEvidenceIds: [EVIDENCE_ONE], conditional: true } },
      { messageId: `judge_${EXECUTION_ID}_conditional`, sequenceOrder: 7, metadata: { score: 72, stance: 'bullish', seenEvidenceIds: [EVIDENCE_ONE], conditional: true } },
    ]);
  });

  it('derives seenEvidenceIds from the evidence-selection checkpoint', async () => {
    const harness = createHarness();
    await repairJudgeProjections({
      stores: harness.stores,
      execution,
      outputs: [sourceOutput([EVIDENCE_TWO]), selectionOutput([EVIDENCE_ONE]), bullOutput()],
    });

    expect(harness.messages.find(message => message.agent === 'bull')?.metadata).toEqual({ claimCount: 0, seenEvidenceIds: [EVIDENCE_ONE] });
  });

  it('projects a current grounded Claim through ClaimStore.save', async () => {
    const harness = createHarness();
    const claim = groundedClaim();
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [bullOutput({ claims: [claim] })] });

    expect(harness.currentClaims).toEqual([{ runId: EXECUTION_ID, messageId: 'bull-message-1', claim }]);
    expect(harness.legacyClaims).toEqual([]);
  });

  it('projects a pre-T2 Claim through the legacy checkpoint projection operation', async () => {
    const harness = createHarness();
    const claim = historicalClaim();
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [bullOutput({ claims: [claim] })] });

    expect(harness.legacyClaims).toEqual([{ runId: EXECUTION_ID, messageId: 'bull-message-1', claim }]);
    expect(harness.currentClaims).toEqual([]);
  });

  it('does not upgrade historical Claims with policy identity or Evidence links', async () => {
    const harness = createHarness();
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [bullOutput({ claims: [historicalClaim()] })] });
    const repaired = harness.legacyClaims[0]!.claim;

    expect(repaired).not.toHaveProperty('policyId');
    expect(repaired).not.toHaveProperty('policyFingerprint');
    expect(repaired).not.toHaveProperty('evidenceLinks');
  });

  it('restores the exact current grounded Counterpoint through CounterpointStore.save', async () => {
    const harness = createHarness();
    const payload = currentBearPayload();
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [selectionOutput(), output('round-1-bear-challenge', 'completed', payload)] });

    expect(harness.counterpoints).toEqual([{
      runId: EXECUTION_ID,
      messageId: 'bear-message-1',
      counterpoint: payload.counterpoints[0],
    }]);
  });

  it('rejects a current Bear response Evidence ID outside seen Evidence', async () => {
    const harness = createHarness();
    const payload = currentBearPayload({ responseEvidenceIds: [EVIDENCE_TWO], counterpointEvidenceIds: [EVIDENCE_ONE] });

    await expect(repairJudgeProjections({
      stores: harness.stores,
      execution,
      outputs: [selectionOutput([EVIDENCE_ONE]), output('round-1-bear-challenge', 'completed', payload)],
    })).rejects.toThrow(`Current Bear checkpoint Evidence ${EVIDENCE_TWO} is outside seen Evidence`);
    expect(harness.counterpoints).toEqual([]);
  });

  it('rejects Counterpoint Evidence outside the Bear response Evidence set', async () => {
    const harness = createHarness();
    const payload = currentBearPayload({ responseEvidenceIds: [EVIDENCE_ONE], counterpointEvidenceIds: [EVIDENCE_TWO] });

    await expect(repairJudgeProjections({
      stores: harness.stores,
      execution,
      outputs: [selectionOutput([EVIDENCE_ONE, EVIDENCE_TWO]), output('round-1-bear-challenge', 'completed', payload)],
    })).rejects.toThrow('Current Counterpoint counterpoint:round-1-bear-challenge:1 Evidence is outside the Bear response or seen Evidence');
    expect(harness.counterpoints).toEqual([]);
  });

  it('rejects Counterpoint Evidence outside seen Evidence', async () => {
    const harness = createHarness();
    const payload = currentBearPayload({ responseEvidenceIds: [EVIDENCE_ONE, EVIDENCE_TWO], counterpointEvidenceIds: [EVIDENCE_TWO] });

    await expect(repairJudgeProjections({
      stores: harness.stores,
      execution,
      outputs: [selectionOutput([EVIDENCE_ONE]), output('round-1-bear-challenge', 'completed', payload)],
    })).rejects.toThrow(`Current Bear checkpoint Evidence ${EVIDENCE_TWO} is outside seen Evidence`);
    expect(harness.counterpoints).toEqual([]);
  });

  it('reconstructs a historical Bear message without creating grounded Counterpoint rows', async () => {
    const harness = createHarness();
    await repairJudgeProjections({
      stores: harness.stores,
      execution,
      outputs: [output('round-1-bear-challenge', 'completed', historicalBearPayload())],
    });

    expect(harness.messages).toHaveLength(1);
    expect(harness.counterpoints).toEqual([]);
  });

  it('rejects mixed current and historical Bear representations', async () => {
    const harness = createHarness();
    const current = currentBearPayload();
    const historical = historicalBearPayload();

    await expect(repairJudgeProjections({
      stores: harness.stores,
      execution,
      outputs: [output('round-1-bear-challenge', 'completed', {
        response: current.response,
        counterpoints: historical.counterpoints,
      })],
    })).rejects.toThrow();
    expect(harness.counterpoints).toEqual([]);
  });

  it('restores a completed Judgment through JudgmentStore.save', async () => {
    const harness = createHarness();
    const value = judgment();
    await repairJudgeProjections({
      stores: harness.stores,
      execution,
      outputs: [output('evaluate-arguments', 'completed', { judgment: value })],
    });

    expect(harness.judgments.get(EXECUTION_ID)).toEqual({ runId: EXECUTION_ID, judgment: value });
  });

  it('uses deterministic WorkflowStep and ModelCall IDs for provenance repair', async () => {
    const harness = createHarness();
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [bullOutput({ audit: modelAudit() })] });

    expect(harness.writes.modelCalls[0]).toMatchObject({
      callId: `call_${EXECUTION_ID}_round-1-bull-thesis_1`,
      runId: EXECUTION_ID,
      stepId: `step_${EXECUTION_ID}_round-1-bull-thesis`,
    });
  });

  it('records restored ModelCall provenance with attempt one', async () => {
    const harness = createHarness();
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [bullOutput({ audit: modelAudit() })] });

    expect(harness.writes.modelCalls[0]?.attempt).toBe(1);
  });

  it('keeps replayed ModelCall cost and currency null', async () => {
    const harness = createHarness();
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [bullOutput({ audit: modelAudit() })] });

    expect(harness.writes.modelCalls[0]).toMatchObject({ cost: null, currency: null });
  });

  it('does not record a duplicate when a ModelCall already exists for the step', async () => {
    const existing: ModelCallRecord = {
      id: `call_${EXECUTION_ID}_round-1-bull-thesis_1`,
      runId: EXECUTION_ID,
      turnId: execution.turnId,
      stepId: `step_${EXECUTION_ID}_round-1-bull-thesis`,
      subagent: 'bull',
      provider: 'mock-provider',
      model: 'mock-model',
      providerId: null,
      modelId: null,
      adapterId: null,
      protocol: null,
      runtimeFingerprint: null,
      attempt: 1,
      inputTokens: 11,
      outputTokens: 22,
      cachedInputTokens: 3,
      totalTokens: 33,
      cost: null,
      currency: null,
      latencyMs: 44,
      finishReason: 'stop',
      contextSnapshotId: 'context-snapshot-1',
      createdAt: execution.createdAt,
    };
    const harness = createHarness({ modelCalls: [existing] });
    await repairJudgeProjections({ stores: harness.stores, execution, outputs: [bullOutput({ audit: modelAudit() })] });

    expect(harness.writes.modelCalls).toEqual([]);
    expect(harness.modelCalls).toHaveLength(1);
  });

  it('is idempotent across repeated projection repair calls', async () => {
    const harness = createHarness();
    const outputs = [
      selectionOutput(),
      bullOutput({ claims: [groundedClaim()], audit: modelAudit() }),
      output('round-1-bear-challenge', 'completed', currentBearPayload()),
      output('evaluate-arguments', 'completed', { judgment: judgment() }),
    ];
    await repairJudgeProjections({ stores: harness.stores, execution, outputs });
    await repairJudgeProjections({ stores: harness.stores, execution, outputs });

    expect(harness.messages).toHaveLength(3);
    expect(harness.currentClaims).toHaveLength(1);
    expect(harness.counterpoints).toHaveLength(1);
    expect(harness.judgments.size).toBe(1);
    expect(harness.modelCalls).toHaveLength(1);
  });

  it('rejects an unknown Judge node', async () => {
    const harness = createHarness();

    await expect(repairJudgeProjections({
      stores: harness.stores,
      execution,
      outputs: [output('unknown-judge-node')],
    })).rejects.toThrow('Judge projection repair references unknown node unknown-judge-node');
  });

  it('has no CLI or concrete database dependency', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/judge/projectionRepair.ts', import.meta.url)), 'utf8');

    expect(source).not.toMatch(/@harness\/database|packages\/database|apps\/cli|FinharnessDatabase|HarnessContext|AgentEvent|ConversationController/);
  });
});
