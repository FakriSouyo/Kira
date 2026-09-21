import { createHash } from 'node:crypto';
import { canonicalJson, UserFriendlyError } from '@harness/shared';
import {
  checkpointKindForNode,
  createJudgeWorkflow,
  judgeWorkflowGraphFingerprint,
  type JudgeBullCheckpoint,
  type JudgeCollectedSourcesCheckpoint,
  type JudgeEvaluationCheckpoint,
  type JudgeEvidenceAuditCheckpoint,
  type JudgeEvidenceSelectionCheckpoint,
  type JudgeFinancialCheckpoint,
  type JudgeMarketCheckpoint,
  type JudgeModelAudit,
  type JudgeNewsCheckpoint,
  type JudgeQuarterlyCheckpoint,
  type JudgeVerdictCheckpoint,
  type JudgeBearCheckpoint,
} from '@harness/command-judge';
import type { WorkflowDefinition, WorkflowNode, WorkflowRestoreSeed } from '@harness/command-core';
import { createWorkflowNodeOutput, type JsonValue, type WorkflowNodeOutput } from '@harness/session-core';
import type { Evidence } from '@harness/schemas';
import { BearCounterpointSchema, BearLLMOutputSchema, BullLLMOutputSchema, ClaimSchema, JudgmentSchema } from '@harness/schemas';
import type { ArtifactEnvelope } from '@harness/schemas';
import { verifyFinancialObservation } from '@harness/financial-data';
import type { SubagentResultLike, RestoredSubagentResult } from '@harness/subagent-core';
import type { LLMCallMetadata } from '@harness/llm';
import type { FinharnessDatabase } from '@harness/database';
import { validateCapabilityPlan, type CapabilityPlan } from '@harness/capability';
import type { ExecutionProfile, ResearchExecution } from '@harness/session-core';
import type { JudgeCommandContext, JudgeNodeId } from '@harness/command-judge';
import type {
  BearChallengeResponse,
  CollectedSources,
  EvidenceSelection,
  JudgeTurn,
  ThesisTurn,
  ChallengeTurn,
  SynthesisTurn,
  JudgeProgress,
} from './judgeNodes';
import type { BullAnalysisResponse } from './judgeNodes';

export interface JudgeCheckpointWriterOptions {
  db: FinharnessDatabase;
  execution: ResearchExecution;
  profile: ExecutionProfile;
  definition: WorkflowDefinition<JudgeCommandContext>;
  initialOutputs?: WorkflowNodeOutput[];
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function workflowDependencyFingerprint(node: { id: string; dependsOn?: string[] }, outputs: ReadonlyMap<string, string>, profileFingerprint = ''): string {
  return digest({
    profileFingerprint,
    nodeId: node.id,
    dependencies: (node.dependsOn ?? []).map(nodeId => ({ nodeId, outputFingerprint: outputs.get(nodeId) ?? null })),
  });
}

function modelAudit(result: SubagentResultLike<unknown>): JudgeModelAudit {
  return {
    subagent: result.subagent,
    skills: result.skills,
    ...(result.modelCall ? {
      modelCall: {
        provider: result.modelCall.provider,
        model: result.modelCall.model,
        ...(result.modelCall.providerId ? { providerId: result.modelCall.providerId } : {}),
        ...(result.modelCall.modelId ? { modelId: result.modelCall.modelId } : {}),
        ...(result.modelCall.adapterId ? { adapterId: result.modelCall.adapterId } : {}),
        ...(result.modelCall.protocol ? { protocol: result.modelCall.protocol } : {}),
        ...(result.modelCall.runtimeFingerprint ? { runtimeFingerprint: result.modelCall.runtimeFingerprint } : {}),
        inputTokens: result.modelCall.inputTokens,
        outputTokens: result.modelCall.outputTokens,
        cachedInputTokens: result.modelCall.cachedInputTokens,
        totalTokens: result.modelCall.totalTokens,
        finishReason: result.modelCall.finishReason,
        latencyMs: result.modelCall.latencyMs,
      },
    } : {}),
    ...(result.contextSnapshotId !== undefined ? { contextSnapshotId: result.contextSnapshotId } : {}),
  };
}

function optionalErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error && error.name && error.name !== 'Error') return error.name;
  return 'PROVIDER_ERROR';
}

async function encodePayload(nodeId: JudgeNodeId, value: unknown, db: FinharnessDatabase): Promise<JsonValue> {
  switch (nodeId) {
    case 'identify-company':
      return value as JudgeFinancialCheckpoint as unknown as JsonValue;
    case 'fetch-financials':
      return value as JudgeQuarterlyCheckpoint as unknown as JsonValue;
    case 'fetch-market-data':
      return { outcome: 'succeeded', ...(value as { daily: unknown; foreign: unknown }) } as unknown as JsonValue;
    case 'fetch-news':
      return { outcome: 'succeeded', ...(value as { news: unknown; filings: unknown; sentiment: unknown }) } as unknown as JsonValue;
    case 'collect-sources': {
      const collected = value as CollectedSources;
      if (!collected.financialSnapshotId) throw new Error(`Judge collect-sources checkpoint for ${collected.evidenceIds.join(',')} has no FinancialSnapshot`);
      const snapshot = await db.financialSnapshots.getById(collected.financialSnapshotId);
      if (!snapshot) throw new Error(`FinancialSnapshot ${collected.financialSnapshotId} was not found for checkpoint persistence`);
      const manifest: JudgeCollectedSourcesCheckpoint = {
        snapshotId: snapshot.snapshotId,
        snapshotFingerprint: snapshot.fingerprint,
        evidenceIds: [...snapshot.materializedEvidenceIds],
        marketEvidenceIds: collected.marketEvidence.map(evidence => evidence.id),
        newsEvidenceIds: collected.newsEvidence.map(evidence => evidence.id),
        marketAvailable: collected.marketAvailable,
        newsAvailable: collected.newsAvailable,
      };
      return manifest as unknown as JsonValue;
    }
    case 'select-supporting-evidence': {
      const selection = value as EvidenceSelection;
      const payload: JudgeEvidenceSelectionCheckpoint = {
        evidenceIds: [...selection.evidenceIds], marketAvailable: selection.marketAvailable, newsAvailable: selection.newsAvailable,
      };
      return payload as unknown as JsonValue;
    }
    case 'round-1-bull-thesis':
      return { response: (value as ThesisTurn).response, claims: (value as ThesisTurn).claims, audit: modelAudit((value as ThesisTurn).result) } as unknown as JsonValue;
    case 'round-1-bear-challenge':
      return { response: (value as ChallengeTurn).response, counterpoints: (value as ChallengeTurn).response.counterpoints, audit: modelAudit((value as ChallengeTurn).result) } as unknown as JsonValue;
    case 'round-2-bull-rebuttal':
      return { response: (value as ThesisTurn).response, claims: (value as ThesisTurn).claims, audit: modelAudit((value as ThesisTurn).result) } as unknown as JsonValue;
    case 'evaluate-arguments':
      return { judgment: (value as JudgeTurn).judgment, allClaims: (value as JudgeTurn).allClaims, needsExtra: (value as JudgeTurn).needsExtra, audit: modelAudit((value as JudgeTurn).result) } as unknown as JsonValue;
    case 'conditional-bear-rechallenge':
      return { response: (value as ChallengeTurn).response, counterpoints: (value as ChallengeTurn).response.counterpoints, audit: modelAudit((value as ChallengeTurn).result) } as unknown as JsonValue;
    case 'conditional-bull-rebuttal':
      return { response: (value as ThesisTurn).response, claims: (value as ThesisTurn).claims, audit: modelAudit((value as ThesisTurn).result) } as unknown as JsonValue;
    case 'resolve-conflicts':
      return { judgment: (value as JudgeTurn).judgment, allClaims: (value as JudgeTurn).allClaims, needsExtra: true, audit: modelAudit((value as JudgeTurn).result) } as unknown as JsonValue;
    case 'check-evidence':
      return value as JudgeEvidenceAuditCheckpoint as unknown as JsonValue;
    case 'synthesize-verdict':
      return value as SynthesisTurn as unknown as JsonValue;
  }
}

export class JudgeCheckpointWriter {
  private readonly fingerprints = new Map<string, string>();

  constructor(private readonly options: JudgeCheckpointWriterOptions) {
    for (const output of options.initialOutputs ?? []) this.fingerprints.set(output.nodeId, output.outputFingerprint);
  }

  async completed(node: WorkflowNode<unknown>, value: unknown, _inputs: Readonly<Record<string, unknown>>): Promise<void> {
    await this.completedValue(node.id as JudgeNodeId, value);
  }

  async completedValue(nodeId: JudgeNodeId, value: unknown): Promise<void> {
    const node = this.options.definition.nodes.find(candidate => candidate.id === nodeId);
    if (!node) throw new Error(`Judge checkpoint references unknown node ${nodeId}`);
    const payload = await encodePayload(nodeId, value, this.options.db);
    const output = createWorkflowNodeOutput({
      executionId: this.options.execution.id,
      workflowId: this.options.profile.workflowId,
      workflowVersion: this.options.profile.workflowVersion,
      nodeId,
      status: 'completed',
      outputKind: checkpointKindForNode(nodeId),
      dependencyFingerprint: workflowDependencyFingerprint(node, this.fingerprints, this.options.profile.fingerprint),
      payload,
      completionGeneration: this.options.execution.resumeGeneration,
      createdAt: new Date().toISOString(),
    });
    const saved = await this.options.db.workflowNodeOutputs.save(output);
    this.fingerprints.set(nodeId, saved.outputFingerprint);
  }

  async skipped(node: WorkflowNode<unknown>): Promise<void> {
    const nodeId = node.id as JudgeNodeId;
    const output = createWorkflowNodeOutput({
      executionId: this.options.execution.id,
      workflowId: this.options.profile.workflowId,
      workflowVersion: this.options.profile.workflowVersion,
      nodeId,
      status: 'skipped',
      outputKind: checkpointKindForNode(nodeId),
      dependencyFingerprint: workflowDependencyFingerprint(node, this.fingerprints, this.options.profile.fingerprint),
      payload: null,
      completionGeneration: this.options.execution.resumeGeneration,
      createdAt: new Date().toISOString(),
    });
    const saved = await this.options.db.workflowNodeOutputs.save(output);
    this.fingerprints.set(nodeId, saved.outputFingerprint);
  }

  async optionalFailure(node: WorkflowNode<unknown>, error: unknown): Promise<void> {
    if (node.id !== 'fetch-market-data' && node.id !== 'fetch-news') return;
    const payload = node.id === 'fetch-market-data'
      ? { outcome: 'optional-failure', errorCode: optionalErrorCode(error) } as JudgeMarketCheckpoint
      : { outcome: 'optional-failure', errorCode: optionalErrorCode(error) } as JudgeNewsCheckpoint;
    const output = createWorkflowNodeOutput({
      executionId: this.options.execution.id,
      workflowId: this.options.profile.workflowId,
      workflowVersion: this.options.profile.workflowVersion,
      nodeId: node.id,
      status: 'completed',
      outputKind: checkpointKindForNode(node.id as JudgeNodeId),
      dependencyFingerprint: workflowDependencyFingerprint(node, this.fingerprints, this.options.profile.fingerprint),
      payload: payload as unknown as JsonValue,
      completionGeneration: this.options.execution.resumeGeneration,
      createdAt: new Date().toISOString(),
    });
    const saved = await this.options.db.workflowNodeOutputs.save(output);
    this.fingerprints.set(node.id, saved.outputFingerprint);
  }
}

export interface JudgeResumePlan {
  profile: ExecutionProfile;
  reasoning: boolean;
  conditional: boolean;
  researchers: { market: boolean; news: boolean };
  restored: WorkflowRestoreSeed[];
  outputs: WorkflowNodeOutput[];
}

interface JudgeProfilePayload {
  reasoningMode: 'usual' | 'reasoning';
  conditional: boolean;
  researchers: { market: boolean; news: boolean };
  provider: string;
  model: string;
  capabilityPlan?: JsonValue;
  capabilityPlanFingerprint?: string;
  runtimePlanFingerprint?: string;
}

function profilePayload(profile: ExecutionProfile): JudgeProfilePayload {
  const payload = profile.payload as unknown as Partial<JudgeProfilePayload>;
  if ((payload.reasoningMode !== 'usual' && payload.reasoningMode !== 'reasoning')
    || typeof payload.conditional !== 'boolean'
    || !payload.researchers || typeof payload.researchers.market !== 'boolean' || typeof payload.researchers.news !== 'boolean'
    || typeof payload.provider !== 'string' || typeof payload.model !== 'string') {
    throw new Error(`Execution profile ${profile.executionId} has an invalid Judge payload`);
  }
  return payload as JudgeProfilePayload;
}

function storedCapabilityPlan(
  payload: JudgeProfilePayload,
  required: boolean,
): CapabilityPlan | undefined {
  const hasPlan = payload.capabilityPlan !== undefined;
  const hasFingerprint = payload.capabilityPlanFingerprint !== undefined;
  if (!hasPlan && !hasFingerprint) {
    if (required) {
      throw new UserFriendlyError(
        'INCOMPATIBLE_CHECKPOINT',
        'This execution predates capability-aware Judge resume authority. Start a new /judge.',
        'Historical Judge executions without capability semantics cannot be resumed; start a new /judge.',
      );
    }
    return undefined;
  }
  if (!hasPlan || typeof payload.capabilityPlanFingerprint !== 'string') {
    throw new UserFriendlyError(
      'INCOMPATIBLE_CHECKPOINT',
      'This execution has an invalid persisted capability plan. Start a new /judge.',
      'Persisted Judge capability semantics are malformed; start a new /judge.',
    );
  }
  try {
    const validated = validateCapabilityPlan(payload.capabilityPlan);
    if (validated.fingerprint !== payload.capabilityPlanFingerprint) {
      throw new Error('Capability plan fingerprint disagreement');
    }
    return validated;
  } catch {
    throw new UserFriendlyError(
      'INCOMPATIBLE_CHECKPOINT',
      'This execution has an invalid persisted capability plan. Start a new /judge.',
      'Persisted Judge capability semantics are malformed; start a new /judge.',
    );
  }
}

function nodeEnabled(nodeId: JudgeNodeId, payload: JudgeProfilePayload, extraRound: boolean): boolean {
  if (nodeId === 'fetch-market-data') return payload.researchers.market;
  if (nodeId === 'fetch-news') return payload.researchers.news;
  if (nodeId === 'conditional-bear-rechallenge' || nodeId === 'conditional-bull-rebuttal' || nodeId === 'resolve-conflicts') {
    return payload.reasoningMode === 'reasoning' || (payload.conditional && extraRound);
  }
  return true;
}

function assertCheckpointEnvelope(output: WorkflowNodeOutput, node: { id: string }, profile: ExecutionProfile, execution: ResearchExecution): void {
  if (output.executionId !== execution.id || output.workflowId !== profile.workflowId || output.workflowVersion !== profile.workflowVersion) {
    throw new Error(`Judge checkpoint ${execution.id}/${node.id} has incompatible workflow identity`);
  }
  if (output.outputKind !== checkpointKindForNode(node.id as JudgeNodeId)) {
    throw new Error(`Judge checkpoint ${execution.id}/${node.id} has unexpected output kind`);
  }
  if (output.completionGeneration > execution.resumeGeneration) {
    throw new Error(`Judge checkpoint ${execution.id}/${node.id} belongs to a future resume generation`);
  }
}

function auditFromPayload(payload: Record<string, unknown>): JudgeModelAudit | undefined {
  return payload.audit && typeof payload.audit === 'object' ? payload.audit as unknown as JudgeModelAudit : undefined;
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`Judge checkpoint has an invalid ${label}`);
  return value;
}

function assertModelAudit(value: unknown): JudgeModelAudit {
  if (typeof value !== 'object' || value === null) throw new Error('Judge checkpoint has an invalid model audit');
  const audit = value as Record<string, unknown>;
  if (typeof audit.subagent !== 'string' || !Array.isArray(audit.skills)
    || audit.skills.some(skill => typeof skill !== 'object' || skill === null
      || typeof (skill as Record<string, unknown>).name !== 'string'
      || typeof (skill as Record<string, unknown>).contentHash !== 'string')) {
    throw new Error('Judge checkpoint has an invalid model audit');
  }
  if (audit.contextSnapshotId !== undefined && audit.contextSnapshotId !== null && typeof audit.contextSnapshotId !== 'string') {
    throw new Error('Judge checkpoint has an invalid ContextSnapshot reference');
  }
  if (audit.modelCall !== undefined) {
    if (typeof audit.modelCall !== 'object' || audit.modelCall === null) throw new Error('Judge checkpoint has an invalid ModelCall audit');
    const call = audit.modelCall as Record<string, unknown>;
    const nullableNumber = (item: unknown) => item === null || (typeof item === 'number' && Number.isFinite(item));
    if (typeof call.provider !== 'string' || typeof call.model !== 'string'
      || !nullableNumber(call.inputTokens) || !nullableNumber(call.outputTokens)
      || !nullableNumber(call.cachedInputTokens) || !nullableNumber(call.totalTokens)
      || (call.finishReason !== null && typeof call.finishReason !== 'string')
      || typeof call.latencyMs !== 'number' || !Number.isFinite(call.latencyMs)) {
      throw new Error('Judge checkpoint has an invalid ModelCall audit');
    }
  }
  return audit as unknown as JudgeModelAudit;
}

function assertSameSemanticParts(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(`Judge checkpoint ${label} does not match its normalized payload`);
}

/** Validates durable Judge outputs before acquisition and derives the restore frontier. */
async function planJudgeCheckpoint(params: {
  db: FinharnessDatabase;
  execution: ResearchExecution;
  profile: ExecutionProfile;
  definition: WorkflowDefinition<JudgeCommandContext>;
  currentGraphFingerprint: string;
  provider: string;
  model: string;
  runtimePlanFingerprint?: string;
  capabilityPlanFingerprint?: string;
  requireCapabilityPlan: boolean;
}): Promise<JudgeResumePlan> {
  const { db, execution, profile, definition } = params;
  if (profile.schemaVersion !== 1 || profile.command !== 'judge' || profile.workflowId !== 'judge') {
    throw new Error('This execution has an unsupported Judge execution profile');
  }
  if (profile.workflowVersion !== 2 || profile.graphFingerprint !== params.currentGraphFingerprint) {
    throw new UserFriendlyError('INCOMPATIBLE_CHECKPOINT', 'This execution predates true Judge checkpoint support. Start a new /judge.', 'Historical interrupted executions cannot be resumed by PR P.');
  }
  const payload = profilePayload(profile);
  const persistedCapabilityPlan = storedCapabilityPlan(payload, params.requireCapabilityPlan);
  if (profile.ticker !== execution.ticker) throw new Error('Judge execution profile ticker does not match the Execution');
  if (params.capabilityPlanFingerprint !== undefined && persistedCapabilityPlan?.fingerprint !== params.capabilityPlanFingerprint) {
    throw new UserFriendlyError(
      'CAPABILITY_MISMATCH',
      'Judge capability authority semantics changed; resume requires the original capability composition or a new /judge.',
      'Restore the original capability composition or start a new /judge.',
    );
  }
  if (payload.provider !== params.provider || payload.model !== params.model) {
    throw new UserFriendlyError('MODEL_MISMATCH', `Resume requires ${payload.provider}/${payload.model}, but the active runtime is ${params.provider}/${params.model}.`, 'Switch back to the original provider/model before resuming.');
  }
  if (payload.runtimePlanFingerprint && payload.runtimePlanFingerprint !== params.runtimePlanFingerprint) {
    throw new UserFriendlyError('MODEL_MISMATCH', 'Resume requires the original semantic runtime plan, but the active runtime plan has changed.', 'Restore the original provider/model/runtime settings before resuming.');
  }

  const outputs = await db.workflowNodeOutputs.listNodeOutputsForExecution(execution.id);
  const byNode = new Map(outputs.map(output => [output.nodeId, output]));
  for (const output of outputs) {
    const node = definition.nodes.find(candidate => candidate.id === output.nodeId);
    if (!node) throw new Error(`Judge checkpoint ${execution.id}/${output.nodeId} references an unknown graph node`);
    assertCheckpointEnvelope(output, node, profile, execution);
  }

  const accepted = new Map<string, WorkflowNodeOutput>();
  const fingerprints = new Map<string, string>();
  const restored: WorkflowRestoreSeed[] = [];
  let extraRound = false;
  for (const node of definition.nodes) {
    const output = byNode.get(node.id);
    if (!output) continue;
    if (!(node.dependsOn ?? []).every(dependency => accepted.has(dependency))) continue;
    const expectedDependencyFingerprint = workflowDependencyFingerprint(node, fingerprints, profile.fingerprint);
    if (output.dependencyFingerprint !== expectedDependencyFingerprint) {
      throw new Error(`Judge checkpoint ${execution.id}/${node.id} has a dependency fingerprint mismatch`);
    }
    const enabled = nodeEnabled(node.id as JudgeNodeId, payload, extraRound);
    if (output.status === 'skipped') {
      if (enabled) throw new Error(`Judge checkpoint ${execution.id}/${node.id} is skipped but enabled by the original profile`);
      accepted.set(node.id, output);
      fingerprints.set(node.id, output.outputFingerprint);
      restored.push({ nodeId: node.id, status: 'skipped' });
      continue;
    }
    if (!enabled) throw new Error(`Judge checkpoint ${execution.id}/${node.id} is completed but disabled by the original profile`);
    const value = await decodeJudgeCheckpoint(node.id as JudgeNodeId, output, db, execution);
    const audit = auditFromPayload(output.payload as Record<string, unknown>);
    if (audit?.contextSnapshotId) {
      const snapshot = await db.contextSnapshots.getById(audit.contextSnapshotId);
      if (!snapshot) throw new Error(`Judge checkpoint ${execution.id}/${node.id} references a missing ContextSnapshot`);
      if (snapshot.sessionId !== execution.sessionId || snapshot.turnId !== execution.turnId) {
        throw new Error(`Judge checkpoint ${execution.id}/${node.id} references a ContextSnapshot outside its lifecycle`);
      }
    }
    accepted.set(node.id, output);
    fingerprints.set(node.id, output.outputFingerprint);
    restored.push({ nodeId: node.id, status: 'completed', value });
    if (node.id === 'evaluate-arguments') extraRound = Boolean((value as JudgeTurn).needsExtra);
  }

  return {
    profile,
    reasoning: payload.reasoningMode === 'reasoning',
    conditional: payload.conditional,
    researchers: payload.researchers,
    restored,
    outputs: [...accepted.values()],
  };
}

/** Validates durable Judge outputs and active capability authority before acquisition. */
export async function planJudgeResume(params: {
  db: FinharnessDatabase;
  execution: ResearchExecution;
  profile: ExecutionProfile;
  definition: WorkflowDefinition<JudgeCommandContext>;
  currentGraphFingerprint: string;
  provider: string;
  model: string;
  runtimePlanFingerprint?: string;
  capabilityPlanFingerprint: string;
}): Promise<JudgeResumePlan> {
  return planJudgeCheckpoint({ ...params, requireCapabilityPlan: true });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function restoreEvidence(db: FinharnessDatabase, ids: string[], execution: ResearchExecution, ticker: string): Promise<Evidence[]> {
  const evidence = await db.evidence.getManyByIds(ids);
  if (evidence.length !== ids.length) throw new Error('Judge checkpoint references missing Evidence');
  const executionEvidence = new Set((await db.evidence.getByRun(execution.id)).map(item => item.id));
  if (evidence.some(item => item.ticker.toUpperCase() !== ticker.toUpperCase() || !executionEvidence.has(item.id))) {
    throw new Error('Judge checkpoint references Evidence outside the canonical Execution');
  }
  // Evidence rows may be content-deduplicated and retain their original row
  // owner. The runEvidence membership above is the authority for this
  // execution; restore the current execution view before specialist validation.
  return evidence.map(item => ({ ...item, runId: execution.id }));
}

export async function decodeJudgeCheckpoint(
  nodeId: JudgeNodeId,
  output: WorkflowNodeOutput,
  db: FinharnessDatabase,
  execution: ResearchExecution,
): Promise<unknown> {
  if (output.status === 'skipped') return undefined;
  if (!output.payload) throw new Error(`Judge checkpoint ${execution.id}/${nodeId} is completed without a payload`);
  const payload = output.payload as Record<string, unknown>;
  switch (nodeId) {
    case 'identify-company':
      verifyFinancialObservation('company_report', payload as unknown as JudgeFinancialCheckpoint, execution.ticker);
      return payload as unknown as JudgeFinancialCheckpoint;
    case 'fetch-financials':
      verifyFinancialObservation('quarterly_financials', payload as unknown as JudgeQuarterlyCheckpoint, execution.ticker);
      return payload as unknown as JudgeQuarterlyCheckpoint;
    case 'fetch-market-data':
      if (payload.outcome === 'optional-failure') {
        if (typeof payload.errorCode !== 'string' || payload.errorCode.length === 0) throw new Error(`Judge checkpoint ${execution.id}/${nodeId} has an invalid optional failure`);
        return undefined;
      }
      if (payload.outcome !== 'succeeded' || typeof payload.daily !== 'object' || payload.daily === null || typeof payload.foreign !== 'object' || payload.foreign === null) {
        throw new Error(`Judge checkpoint ${execution.id}/${nodeId} has an invalid market payload`);
      }
      verifyFinancialObservation('daily_transaction', payload.daily as never, execution.ticker);
      verifyFinancialObservation('foreign_flow', payload.foreign as never, execution.ticker);
      return { daily: payload.daily, foreign: payload.foreign };
    case 'fetch-news':
      if (payload.outcome === 'optional-failure') {
        if (typeof payload.errorCode !== 'string' || payload.errorCode.length === 0) throw new Error(`Judge checkpoint ${execution.id}/${nodeId} has an invalid optional failure`);
        return undefined;
      }
      if (payload.outcome !== 'succeeded' || typeof payload.news !== 'object' || payload.news === null || typeof payload.filings !== 'object' || payload.filings === null || typeof payload.sentiment !== 'object' || payload.sentiment === null) {
        throw new Error(`Judge checkpoint ${execution.id}/${nodeId} has an invalid news payload`);
      }
      verifyFinancialObservation('news', payload.news as never, execution.ticker);
      verifyFinancialObservation('filings', payload.filings as never, execution.ticker);
      verifyFinancialObservation('sentiment', payload.sentiment as never, execution.ticker);
      return { news: payload.news, filings: payload.filings, sentiment: payload.sentiment };
    case 'collect-sources': {
      const manifest = payload as unknown as JudgeCollectedSourcesCheckpoint;
      if (typeof manifest.snapshotId !== 'string' || typeof manifest.snapshotFingerprint !== 'string'
        || typeof manifest.marketAvailable !== 'boolean' || typeof manifest.newsAvailable !== 'boolean') {
        throw new Error(`Judge checkpoint ${execution.id}/${nodeId} has an invalid source manifest`);
      }
      const evidenceIds = assertStringArray(manifest.evidenceIds, 'source manifest evidence IDs');
      const marketEvidenceIds = assertStringArray(manifest.marketEvidenceIds, 'market evidence IDs');
      const newsEvidenceIds = assertStringArray(manifest.newsEvidenceIds, 'news evidence IDs');
      const evidenceSet = new Set(evidenceIds);
      if ([...marketEvidenceIds, ...newsEvidenceIds].some(id => !evidenceSet.has(id))) {
        throw new Error(`Judge checkpoint ${execution.id}/${nodeId} references Evidence outside its manifest`);
      }
      const snapshot = await db.financialSnapshots.getById(manifest.snapshotId);
      if (!snapshot || snapshot.executionId !== execution.id || snapshot.subject.ticker !== execution.ticker || snapshot.fingerprint !== manifest.snapshotFingerprint) {
        throw new Error(`Judge checkpoint ${execution.id}/collect-sources has an invalid FinancialSnapshot reference`);
      }
      if (!sameIds([...snapshot.materializedEvidenceIds], evidenceIds)) throw new Error('Judge checkpoint evidence set conflicts with FinancialSnapshot');
      const all = await restoreEvidence(db, evidenceIds, execution, execution.ticker);
      const marketIds = new Set(marketEvidenceIds);
      const newsIds = new Set(newsEvidenceIds);
      return {
        evidence: all.filter(item => !marketIds.has(item.id) && !newsIds.has(item.id)),
        evidenceIds,
        marketEvidence: all.filter(item => marketIds.has(item.id)),
        newsEvidence: all.filter(item => newsIds.has(item.id)),
        marketAvailable: manifest.marketAvailable,
        newsAvailable: manifest.newsAvailable,
        financialSnapshotId: snapshot.snapshotId,
      } satisfies CollectedSources;
    }
    case 'select-supporting-evidence': {
      const selection = payload as unknown as JudgeEvidenceSelectionCheckpoint;
      if (typeof selection.marketAvailable !== 'boolean' || typeof selection.newsAvailable !== 'boolean') throw new Error(`Judge checkpoint ${execution.id}/${nodeId} has an invalid evidence selection`);
      const evidenceIds = assertStringArray(selection.evidenceIds, 'selected evidence IDs');
      const evidence = await restoreEvidence(db, evidenceIds, execution, execution.ticker);
      return { ...selection, evidenceIds, evidence, evidenceZone: buildEvidenceZoneForRestore(execution.ticker, evidence) } satisfies EvidenceSelection;
    }
    case 'round-1-bull-thesis':
    case 'round-2-bull-rebuttal':
    case 'conditional-bull-rebuttal': {
      const checkpoint = payload as unknown as JudgeBullCheckpoint;
      BullLLMOutputSchema.parse(checkpoint.response);
      const claims = ClaimSchema.array().parse(checkpoint.claims);
      if (typeof (checkpoint.response as Record<string, unknown>).messageId !== 'string') throw new Error(`Judge checkpoint ${execution.id}/${nodeId} has no message identity`);
      const audit = assertModelAudit(checkpoint.audit);
      return { response: checkpoint.response as unknown as BullAnalysisResponse, claims, result: resultFromAudit(audit, checkpoint.response) } satisfies ThesisTurn;
    }
    case 'round-1-bear-challenge':
    case 'conditional-bear-rechallenge': {
      const checkpoint = payload as unknown as JudgeBearCheckpoint;
      const response = BearLLMOutputSchema.parse(checkpoint.response);
      const counterpoints = BearCounterpointSchema.array().parse(checkpoint.counterpoints);
      if (typeof (checkpoint.response as Record<string, unknown>).messageId !== 'string') throw new Error(`Judge checkpoint ${execution.id}/${nodeId} has no message identity`);
      assertSameSemanticParts(response.counterpoints, counterpoints, `${execution.id}/${nodeId} counterpoints`);
      const audit = assertModelAudit(checkpoint.audit);
      return { response: checkpoint.response as unknown as BearChallengeResponse, result: resultFromAudit(audit, checkpoint.response) } satisfies ChallengeTurn;
    }
    case 'evaluate-arguments':
    case 'resolve-conflicts': {
      const checkpoint = payload as unknown as JudgeEvaluationCheckpoint;
      const judgment = JudgmentSchema.parse(checkpoint.judgment);
      if (judgment.ticker.toUpperCase() !== execution.ticker.toUpperCase() || typeof checkpoint.needsExtra !== 'boolean') {
        throw new Error(`Judge checkpoint ${execution.id}/${nodeId} has an invalid evaluation payload`);
      }
      const allClaims = ClaimSchema.array().parse(checkpoint.allClaims);
      const audit = assertModelAudit(checkpoint.audit);
      return { judgment, allClaims, needsExtra: checkpoint.needsExtra, result: resultFromAudit(audit, checkpoint.judgment) } satisfies JudgeTurn;
    }
    case 'check-evidence': {
      const audit = payload as unknown as JudgeEvidenceAuditCheckpoint;
      if (!Number.isInteger(audit.claims) || audit.claims < 0 || !Number.isInteger(audit.challenges) || audit.challenges < 0) {
        throw new Error(`Judge checkpoint ${execution.id}/${nodeId} has invalid evidence audit counts`);
      }
      return { ...audit, evidenceIds: assertStringArray(audit.evidenceIds, 'audited evidence IDs') };
    }
    case 'synthesize-verdict': {
      const verdict = payload as unknown as JudgeVerdictCheckpoint;
      const judgment = JudgmentSchema.parse(verdict.judgment);
      if (judgment.ticker.toUpperCase() !== execution.ticker.toUpperCase() || (verdict.rounds !== 1 && verdict.rounds !== 2)) {
        throw new Error(`Judge checkpoint ${execution.id}/${nodeId} has an invalid verdict payload`);
      }
      return { judgment, rounds: verdict.rounds } satisfies SynthesisTurn;
    }
  }
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
    const conditional = nodeId === 'conditional-bear-rechallenge';
    const content = `${response.reasoning ?? ''}\n${(response.counterpoints ?? []).map((counterpoint, index) => `Challenge #${index + 1} (targets claim ${counterpoint.targetClaimId}, strength ${counterpoint.strength}): ${counterpoint.argument}`).join('\n')}`;
    return {
      messageId: conditional ? `${response.messageId}_conditional` : response.messageId,
      agent: 'bear', messageType: 'challenge', content, evidenceIds: response.evidenceIds ?? [],
      sequenceOrder: conditional ? 5 : 2,
      metadata: { challengeCount: response.counterpoints?.length ?? 0, seenEvidenceIds, ...(conditional ? { conditional: true } : {}) },
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
  db: FinharnessDatabase;
  execution: ResearchExecution;
  outputs: WorkflowNodeOutput[];
}): Promise<void> {
  const definition = createJudgeWorkflow();
  const selectionOutput = params.outputs.find(output => output.nodeId === 'select-supporting-evidence' && output.status === 'completed');
  const seenEvidenceIds = selectionOutput?.payload && typeof selectionOutput.payload === 'object'
    && Array.isArray((selectionOutput.payload as Record<string, unknown>).evidenceIds)
    ? (selectionOutput.payload as { evidenceIds: unknown[] }).evidenceIds.filter((id): id is string => typeof id === 'string')
    : [];
  for (const output of params.outputs) {
    const nodeId = output.nodeId as JudgeNodeId;
    const node = definition.nodes.find(candidate => candidate.id === nodeId);
    if (!node) throw new Error(`Judge projection repair references unknown node ${nodeId}`);
    const payload = output.payload as Record<string, unknown> | null;
    const optionalFailure = payload?.outcome === 'optional-failure';
    const existingStep = await params.db.sessions.getStep(params.execution.id, nodeId);
    const desiredStatus = output.status === 'skipped' ? 'skipped' : optionalFailure ? 'failed' : 'completed';
    if (!existingStep || existingStep.status !== desiredStatus) {
      const audit = payload ? auditFromPayload(payload) : undefined;
      await params.db.sessions.saveStep({
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
      await params.db.conversation.addMessage({ runId: params.execution.id, ...message });
    }
    const claims = (completedPayload.claims ?? []) as Array<Record<string, unknown>>;
    if (claims.length > 0 && (nodeId === 'round-1-bull-thesis' || nodeId === 'round-2-bull-rebuttal' || nodeId === 'conditional-bull-rebuttal')) {
      const messageId = message?.messageId ?? '';
      for (const claim of claims) await params.db.claims.save({
        runId: params.execution.id,
        messageId,
        claim: claim as never,
      });
    }
    if ((nodeId === 'evaluate-arguments' || nodeId === 'resolve-conflicts') && completedPayload.judgment) {
      await params.db.judgments.save({ runId: params.execution.id, judgment: completedPayload.judgment as never });
    }
    const audit = auditFromPayload(completedPayload);
    if (audit?.modelCall) {
      const stepId = `step_${params.execution.id}_${nodeId}`;
      const existing = await params.db.sessions.listModelCallsForStep(params.execution.id, stepId);
      if (existing.length === 0) {
        const modelCall = audit.modelCall;
        await params.db.sessions.recordModelCall({
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
}

function requiredOutput(outputs: ReadonlyMap<string, WorkflowNodeOutput>, nodeId: JudgeNodeId): WorkflowNodeOutput {
  const output = outputs.get(nodeId);
  if (!output || output.status !== 'completed' || output.payload === null) {
    throw new Error(`Judge execution is missing the completed ${nodeId} checkpoint required for publication`);
  }
  return output;
}

/** Rebuilds the three immutable Judge artifacts from validated node checkpoints. */
export async function ensureJudgeArtifacts(params: {
  db: FinharnessDatabase;
  execution: ResearchExecution;
  profile: ExecutionProfile;
}): Promise<ArtifactEnvelope[]> {
  const definition = createJudgeWorkflow();
  const payload = profilePayload(params.profile);
  const plan = await planJudgeCheckpoint({
    db: params.db,
    execution: params.execution,
    profile: params.profile,
    definition,
    currentGraphFingerprint: judgeWorkflowGraphFingerprint(definition),
    provider: payload.provider,
    model: payload.model,
    runtimePlanFingerprint: payload.runtimePlanFingerprint,
    requireCapabilityPlan: false,
  });
  const outputs = new Map(plan.outputs.map(output => [output.nodeId, output]));
  const collected = await decodeJudgeCheckpoint('collect-sources', requiredOutput(outputs, 'collect-sources'), params.db, params.execution) as CollectedSources;
  const thesis = await decodeJudgeCheckpoint('round-1-bull-thesis', requiredOutput(outputs, 'round-1-bull-thesis'), params.db, params.execution) as ThesisTurn;
  const challenge = await decodeJudgeCheckpoint('round-1-bear-challenge', requiredOutput(outputs, 'round-1-bear-challenge'), params.db, params.execution) as ChallengeTurn;
  const rebuttal = await decodeJudgeCheckpoint('round-2-bull-rebuttal', requiredOutput(outputs, 'round-2-bull-rebuttal'), params.db, params.execution) as ThesisTurn;
  const synthesis = await decodeJudgeCheckpoint('synthesize-verdict', requiredOutput(outputs, 'synthesize-verdict'), params.db, params.execution) as SynthesisTurn;
  const storedClaims = await params.db.claims.getByRun(params.execution.id);
  const createdAt = params.execution.completedAt ?? new Date().toISOString();
  return await params.db.artifacts.saveMany([
    {
      artifactId: `artifact_bull_case_${params.execution.id}`,
      kind: 'BULL_CASE', schemaVersion: 1,
      sessionId: params.execution.sessionId, turnId: params.execution.turnId, executionId: params.execution.id,
      ticker: params.execution.ticker,
      payload: {
        thesis: { ...thesis.response, claims: thesis.claims },
        rebuttal: { ...rebuttal.response, claims: rebuttal.claims },
      },
      createdAt,
    },
    {
      artifactId: `artifact_bear_case_${params.execution.id}`,
      kind: 'BEAR_CASE', schemaVersion: 1,
      sessionId: params.execution.sessionId, turnId: params.execution.turnId, executionId: params.execution.id,
      ticker: params.execution.ticker,
      payload: challenge.response,
      createdAt,
    },
    {
      artifactId: `artifact_verdict_${params.execution.id}`,
      kind: 'VERDICT', schemaVersion: 1,
      sessionId: params.execution.sessionId, turnId: params.execution.turnId, executionId: params.execution.id,
      ticker: params.execution.ticker,
      payload: {
        judgment: synthesis.judgment,
        evidenceIds: collected.evidenceIds,
        claimIds: storedClaims.map(claim => claim.claimId),
        rounds: synthesis.rounds,
      },
      createdAt,
    },
  ]);
}

/** Repairs only compatible, completed lifecycle Judge executions in one session. */
export async function repairCompletedJudgeArtifacts(params: {
  db: FinharnessDatabase;
  sessionId: string;
}): Promise<number> {
  const artifacts = await params.db.sessions.getSessionArtifacts(params.sessionId);
  let repaired = 0;
  for (const execution of artifacts.executions) {
    if (execution.command !== 'judge' || execution.status !== 'completed') continue;
    const profile = await params.db.executionProfiles.getByExecutionId(execution.id);
    if (!profile || profile.workflowId !== 'judge' || profile.workflowVersion !== 2) continue;
    const existing = await params.db.artifacts.getByExecution(execution.id);
    if (existing.length === 3) continue;
    await ensureJudgeArtifacts({ db: params.db, execution, profile });
    repaired += 1;
  }
  return repaired;
}

function resultFromAudit(audit: JudgeModelAudit, value: unknown): RestoredSubagentResult<unknown> {
  const modelCall: LLMCallMetadata | undefined = audit.modelCall ? {
    provider: audit.modelCall.provider as LLMCallMetadata['provider'],
    model: audit.modelCall.model,
    ...(audit.modelCall.providerId ? { providerId: audit.modelCall.providerId } : {}),
    ...(audit.modelCall.modelId ? { modelId: audit.modelCall.modelId } : {}),
    ...(audit.modelCall.adapterId ? { adapterId: audit.modelCall.adapterId } : {}),
    ...(audit.modelCall.protocol ? { protocol: audit.modelCall.protocol } : {}),
    ...(audit.modelCall.runtimeFingerprint ? { runtimeFingerprint: audit.modelCall.runtimeFingerprint } : {}),
    inputTokens: audit.modelCall.inputTokens,
    outputTokens: audit.modelCall.outputTokens,
    cachedInputTokens: audit.modelCall.cachedInputTokens,
    totalTokens: audit.modelCall.totalTokens,
    finishReason: audit.modelCall.finishReason,
    latencyMs: audit.modelCall.latencyMs,
  } : undefined;
  return { value, subagent: audit.subagent, skills: audit.skills, ...(modelCall ? { modelCall } : {}), ...(audit.contextSnapshotId !== undefined ? { contextSnapshotId: audit.contextSnapshotId } : {}) };
}

function buildEvidenceZoneForRestore(ticker: string, evidence: Evidence[]): string {
  return [`Ticker: ${ticker}`, '', ...evidence.map((item, index) => `[Evidence ${index + 1}] ${item.source} (${item.id})\n${JSON.stringify(item.data)}`)].join('\n');
}

export type { JudgeProgress };
