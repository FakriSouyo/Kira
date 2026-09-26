import { createJudgeWorkflow, type JudgeCollectedSourcesCheckpoint, type JudgeNodeId } from '@harness/command-judge';
import type { ConversationStore } from '@harness/conversation';
import type { ClaimStore, CounterpointStore, GroundedClaim, JudgmentStore } from '@harness/execution';
import { ClaimSchema, type GroundedCounterpoint } from '@harness/schemas';
import type { ModelCallRecord, ResearchExecution, ResearchSessionStore, WorkflowNodeOutput } from '@harness/session-core';
import { auditFromPayload, parseCheckpointCounterpoints } from './checkpointResume.js';

/** Narrow host-supplied persistence operations used while restoring Judge projections. */
export interface JudgeProjectionRepairStores {
  readonly trace: Pick<ResearchSessionStore, 'getStep' | 'saveStep' | 'recordModelCall'> & {
    listModelCallsForStep(runId: string, stepId: string): Promise<ModelCallRecord[]>;
  };
  readonly conversation: Pick<ConversationStore, 'addMessage'>;
  readonly claims: Pick<ClaimStore, 'save' | 'repairLegacyCheckpointProjection'>;
  readonly counterpoints: Pick<CounterpointStore, 'save'>;
  readonly judgments: Pick<JudgmentStore, 'save'>;
}

function checkpointMessage(nodeId: JudgeNodeId, runId: string, ticker: string, payload: Record<string, unknown>, seenEvidenceIds: string[]): {
  messageId: string; agent: 'researcher' | 'bull' | 'bear' | 'judge'; messageType: 'observation' | 'claim' | 'challenge' | 'response' | 'decision'; content: string; evidenceIds: string[]; sequenceOrder: number; metadata: Record<string, unknown>;
} | undefined {
  if (nodeId === 'collect-sources') {
    const manifest = payload as unknown as JudgeCollectedSourcesCheckpoint;
    return {
      messageId: `researcher_${runId}`, agent: 'researcher', messageType: 'observation',
      content: `I retrieved the evidence for ${ticker} and stored it for this run.`,
      evidenceIds: manifest.evidenceIds, sequenceOrder: 0,
      metadata: { marketAvailable: manifest.marketAvailable, newsAvailable: manifest.newsAvailable },
    };
  }
  if (nodeId === 'round-1-bull-thesis' || nodeId === 'round-2-bull-rebuttal' || nodeId === 'conditional-bull-rebuttal') {
    const response = payload.response as { messageId: string; reasoning?: string; evidenceIds?: string[] };
    const conditional = nodeId === 'conditional-bull-rebuttal';
    return {
      messageId: conditional ? `${response.messageId}_conditional` : response.messageId,
      agent: 'bull', messageType: nodeId === 'round-1-bull-thesis' ? 'claim' : 'response',
      content: response.reasoning ?? '', evidenceIds: response.evidenceIds ?? [],
      sequenceOrder: conditional ? 6 : nodeId === 'round-2-bull-rebuttal' ? 3 : 1,
      metadata: { claimCount: Array.isArray(payload.claims) ? payload.claims.length : 0, seenEvidenceIds, ...(conditional ? { conditional: true } : {}) },
    };
  }
  if (nodeId === 'round-1-bear-challenge' || nodeId === 'conditional-bear-rechallenge') {
    const response = payload.response as { messageId: string; reasoning?: string; evidenceIds?: string[]; counterpoints?: Array<{ targetClaimId: string; strength: string; argument: string }> };
    const counterpoints = Array.isArray(payload.counterpoints)
      ? payload.counterpoints as Array<{ targetClaimId: string; strength: string; argument: string }>
      : response.counterpoints ?? [];
    const conditional = nodeId === 'conditional-bear-rechallenge';
    const content = `${response.reasoning ?? ''}\n${counterpoints.map((counterpoint, index) => `Challenge #${index + 1} (targets claim ${counterpoint.targetClaimId}, strength ${counterpoint.strength}): ${counterpoint.argument}`).join('\n')}`;
    return {
      messageId: conditional ? `${response.messageId}_conditional` : response.messageId,
      agent: 'bear', messageType: 'challenge', content, evidenceIds: response.evidenceIds ?? [],
      sequenceOrder: conditional ? 5 : 2,
      metadata: { challengeCount: counterpoints.length, seenEvidenceIds, ...(conditional ? { conditional: true } : {}) },
    };
  }
  if (nodeId === 'evaluate-arguments' || nodeId === 'resolve-conflicts') {
    const judgment = payload.judgment as { summary: string; score: number; stance: string };
    const conditional = nodeId === 'resolve-conflicts';
    return {
      messageId: conditional ? `judge_${runId}_conditional` : `judge_${runId}`,
      agent: 'judge', messageType: 'decision', content: judgment.summary, evidenceIds: [],
      sequenceOrder: conditional ? 7 : 4,
      metadata: { score: judgment.score, stance: judgment.stance, seenEvidenceIds, ...(conditional ? { conditional: true } : {}) },
    };
  }
  return undefined;
}

/** Repairs projections needed by downstream restored nodes without rerunning them. */
export async function repairJudgeProjections(params: {
  stores: JudgeProjectionRepairStores;
  execution: ResearchExecution;
  outputs: WorkflowNodeOutput[];
}): Promise<void> {
  const definition = createJudgeWorkflow();
  const selectionOutput = params.outputs.find(output => output.nodeId === 'select-supporting-evidence' && output.status === 'completed');
  const seenEvidenceIds = selectionOutput?.payload && typeof selectionOutput.payload === 'object'
    && Array.isArray((selectionOutput.payload as Record<string, unknown>).evidenceIds)
    ? (selectionOutput.payload as { evidenceIds: unknown[] }).evidenceIds.filter((id): id is string => typeof id === 'string')
    : [];
  const currentCounterpointsToRepair: Array<{ messageId: string; counterpoint: GroundedCounterpoint }> = [];
  for (const output of params.outputs) {
    const nodeId = output.nodeId as JudgeNodeId;
    const node = definition.nodes.find(candidate => candidate.id === nodeId);
    if (!node) throw new Error(`Judge projection repair references unknown node ${nodeId}`);
    const payload = output.payload as Record<string, unknown> | null;
    const parsedBearCounterpoints = output.status === 'completed' && payload
      && (nodeId === 'round-1-bear-challenge' || nodeId === 'conditional-bear-rechallenge')
      ? parseCheckpointCounterpoints(nodeId, payload.response, payload.counterpoints, `${params.execution.id}/${nodeId}`)
      : undefined;
    const optionalFailure = payload?.outcome === 'optional-failure';
    const existingStep = await params.stores.trace.getStep(params.execution.id, nodeId);
    const desiredStatus = output.status === 'skipped' ? 'skipped' : optionalFailure ? 'failed' : 'completed';
    if (!existingStep || existingStep.status !== desiredStatus) {
      const audit = payload ? auditFromPayload(payload) : undefined;
      await params.stores.trace.saveStep({
        stepId: existingStep?.id ?? `step_${params.execution.id}_${nodeId}`,
        runId: params.execution.id,
        nodeId,
        parentNodeIds: node.dependsOn ?? [],
        subagent: existingStep?.subagent ?? audit?.subagent ?? (node.executor?.kind === 'subagent' ? node.executor.id : undefined),
        skills: existingStep?.skills ?? audit?.skills ?? [],
        status: desiredStatus,
        ...(existingStep?.durationMs !== null && existingStep?.durationMs !== undefined ? { durationMs: existingStep.durationMs } : {}),
        ...(existingStep?.summary ? { summary: existingStep.summary } : {}),
        ...(optionalFailure ? { error: String(payload?.errorCode ?? 'PROVIDER_ERROR') } : {}),
      });
    }
    if (output.status !== 'completed' || output.payload === null) continue;
    const completedPayload = output.payload as Record<string, unknown>;
    const message = checkpointMessage(nodeId, params.execution.id, params.execution.ticker, completedPayload, seenEvidenceIds);
    if (message) {
      await params.stores.conversation.addMessage({ runId: params.execution.id, ...message });
    }
    if (nodeId === 'round-1-bear-challenge' || nodeId === 'conditional-bear-rechallenge') {
      if (!parsedBearCounterpoints) throw new Error(`Judge checkpoint ${params.execution.id}/${nodeId} has no validated Counterpoint list`);
      if (parsedBearCounterpoints.kind === 'current') {
        const { response, counterpoints } = parsedBearCounterpoints;
        const seen = new Set(seenEvidenceIds);
        const responseIds = new Set(response.evidenceIds);
        for (const id of response.evidenceIds) {
          if (!seen.has(id)) throw new Error(`Current Bear checkpoint Evidence ${id} is outside seen Evidence`);
        }
        counterpoints.forEach(counterpoint => {
          if (counterpoint.evidenceIds.some(id => !responseIds.has(id) || !seen.has(id))) {
            throw new Error(`Current Counterpoint ${counterpoint.counterpointId} Evidence is outside the Bear response or seen Evidence`);
          }
          if (!message?.messageId) throw new Error(`Current Counterpoint ${counterpoint.counterpointId} has no durable message identity`);
          currentCounterpointsToRepair.push({ messageId: message.messageId, counterpoint });
        });
      }
    }
    const claims = (completedPayload.claims ?? []) as Array<Record<string, unknown>>;
    if (claims.length > 0 && (nodeId === 'round-1-bull-thesis' || nodeId === 'round-2-bull-rebuttal' || nodeId === 'conditional-bull-rebuttal')) {
      const messageId = message?.messageId ?? '';
      for (const rawClaim of claims) {
        const claim = ClaimSchema.parse(rawClaim);
        if (claim.policyId === undefined && claim.policyFingerprint === undefined && claim.evidenceLinks === undefined) {
          await params.stores.claims.repairLegacyCheckpointProjection({ runId: params.execution.id, messageId, claim });
        } else {
          await params.stores.claims.save({ runId: params.execution.id, messageId, claim: claim as GroundedClaim });
        }
      }
    }
    if ((nodeId === 'evaluate-arguments' || nodeId === 'resolve-conflicts') && completedPayload.judgment) {
      await params.stores.judgments.save({ runId: params.execution.id, judgment: completedPayload.judgment as never });
    }
    const audit = auditFromPayload(completedPayload);
    if (audit?.modelCall) {
      const stepId = `step_${params.execution.id}_${nodeId}`;
      const existing = await params.stores.trace.listModelCallsForStep(params.execution.id, stepId);
      if (existing.length === 0) {
        const modelCall = audit.modelCall;
        await params.stores.trace.recordModelCall({
          callId: `call_${params.execution.id}_${nodeId}_1`,
          runId: params.execution.id,
          stepId,
          subagent: audit.subagent,
          provider: modelCall.provider,
          model: modelCall.model,
          providerId: modelCall.providerId ?? null,
          modelId: modelCall.modelId ?? null,
          adapterId: modelCall.adapterId ?? null,
          protocol: modelCall.protocol ?? null,
          runtimeFingerprint: modelCall.runtimeFingerprint ?? null,
          attempt: 1,
          inputTokens: modelCall.inputTokens,
          outputTokens: modelCall.outputTokens,
          cachedInputTokens: modelCall.cachedInputTokens,
          totalTokens: modelCall.totalTokens,
          latencyMs: modelCall.latencyMs,
          finishReason: modelCall.finishReason,
          cost: null,
          currency: null,
          contextSnapshotId: audit.contextSnapshotId ?? null,
        });
      }
    }
  }
  for (const current of currentCounterpointsToRepair) {
    await params.stores.counterpoints.save({
      runId: params.execution.id,
      messageId: current.messageId,
      counterpoint: current.counterpoint,
    });
  }
}
