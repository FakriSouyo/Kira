import { canonicalJson } from '@harness/shared';
import {
  createJudgeWorkflow,
  JUDGE_RELEASE_CONTRACT,
  judgeWorkflowGraphFingerprint,
  JUDGE_RELEASE_CONTRACT_ID,
  JUDGE_RELEASE_CONTRACT_FINGERPRINT,
  type JudgeNodeId,
} from '@harness/command-judge';
import type { WorkflowNodeOutput, ArtifactStore, ExecutionProfile, ResearchExecution } from '@harness/session-core';
import { ArtifactEnvelopeSchema, ClaimSchema, type ArtifactEnvelope, type GroundedCounterpoint } from '@harness/schemas';
import {
  buildClaimGraph,
  claimGraphFingerprint,
  CLAIM_GRAPH_CONTRACT_FINGERPRINT,
  CLAIM_GRAPH_ID,
  CLAIM_GRAPH_VERSION,
  CLAIM_POLICY_FINGERPRINT,
  CLAIM_POLICY_ID,
  COUNTERPOINT_POLICY_FINGERPRINT,
  COUNTERPOINT_POLICY_ID,
  createClaimGraphReleaseReceipt,
  storedClaimToClaim,
  storedCounterpointToCounterpoint,
  type ClaimGraph,
  type ClaimGraphArtifactProjection,
  type ClaimGraphNodeRef,
  type ClaimGraphReleaseReceipt,
  type ClaimGraphReleaseStore,
  type ClaimGraphReader,
  type ClaimStore,
  type CounterpointStore,
} from '@harness/execution';
import {
  judgeReleaseKind,
  parseCheckpointCounterpoints,
  planJudgeCheckpoint,
  type JudgeCheckpointReadStores,
  type JudgeResumePlan,
} from './checkpointResume.js';
import type {
  ChallengeTurn,
  CollectedSources,
  JudgeTurn,
  SynthesisTurn,
  ThesisTurn,
} from './nodeRuntime.js';

/** Narrow host-supplied persistence operations needed by current Judge release. */
export interface JudgeReleaseStores extends JudgeCheckpointReadStores {
  readonly claims: Pick<ClaimStore, 'getByRun'>;
  readonly counterpoints: Pick<CounterpointStore, 'getByRun'>;
  readonly claimGraph: ClaimGraphReader;
  readonly artifacts: Pick<ArtifactStore, 'saveMany'>;
  readonly claimGraphReleases: Pick<ClaimGraphReleaseStore, 'save'>;
}
export function requiredJudgeCheckpointOutput(outputs: ReadonlyMap<string, WorkflowNodeOutput>, nodeId: JudgeNodeId): WorkflowNodeOutput {
  const output = outputs.get(nodeId);
  if (!output || output.status !== 'completed' || output.payload === null) {
    throw new Error(`Judge execution is missing the completed ${nodeId} checkpoint required for publication`);
  }
  return output;
}

export interface JudgeArtifactContents {
  collected: CollectedSources;
  thesis: ThesisTurn;
  challenge: ChallengeTurn;
  rebuttal: ThesisTurn;
  synthesis: SynthesisTurn;
  claimIds: string[];
}

export function buildJudgeArtifactEnvelopes(execution: ResearchExecution, contents: JudgeArtifactContents, createdAt: string): ArtifactEnvelope[] {
  const base = {
    sessionId: execution.sessionId,
    turnId: execution.turnId,
    executionId: execution.id,
    ticker: execution.ticker,
    createdAt,
  };
  return [
    ArtifactEnvelopeSchema.parse({
      ...base,
      artifactId: `artifact_bull_case_${execution.id}`,
      kind: 'BULL_CASE', schemaVersion: 1,
      payload: {
        thesis: { ...contents.thesis.response, claims: contents.thesis.claims },
        rebuttal: { ...contents.rebuttal.response, claims: contents.rebuttal.claims },
      },
    }),
    ArtifactEnvelopeSchema.parse({
      ...base,
      artifactId: `artifact_bear_case_${execution.id}`,
      kind: 'BEAR_CASE', schemaVersion: 1,
      payload: { ...contents.challenge.response, counterpoints: contents.challenge.counterpoints },
    }),
    ArtifactEnvelopeSchema.parse({
      ...base,
      artifactId: `artifact_verdict_${execution.id}`,
      kind: 'VERDICT', schemaVersion: 1,
      payload: {
        judgment: contents.synthesis.judgment,
        evidenceIds: contents.collected.evidenceIds,
        claimIds: contents.claimIds,
        rounds: contents.synthesis.rounds,
      },
    }),
  ];
}

function restoredValue<T>(plan: JudgeResumePlan, nodeId: JudgeNodeId): T {
  const seed = plan.restored.find(candidate => candidate.nodeId === nodeId);
  if (!seed || seed.status !== 'completed') throw new Error(`Judge release is missing the completed ${nodeId} checkpoint value`);
  return seed.value as T;
}

function assertCurrentClaimParity(
  executionId: string,
  expectedByNode: readonly { nodeId: JudgeNodeId; messageId: string; claims: readonly unknown[] }[],
  stored: Awaited<ReturnType<JudgeReleaseStores['claims']['getByRun']>>,
): void {
  const expected = new Map<string, { messageId: string; value: ReturnType<typeof ClaimSchema.parse> }>();
  for (const group of expectedByNode) {
    for (const raw of group.claims) {
      const claim = ClaimSchema.parse(raw);
      if (claim.policyId !== CLAIM_POLICY_ID || claim.policyFingerprint !== CLAIM_POLICY_FINGERPRINT) {
        throw new Error(`Current Claim ${claim.claimId} in ${executionId}/${group.nodeId} has unsupported Policy metadata`);
      }
      if (expected.has(claim.claimId)) throw new Error(`Judge checkpoints contain duplicate Claim ${claim.claimId}`);
      expected.set(claim.claimId, { messageId: group.messageId, value: claim });
    }
  }
  if (stored.length !== expected.size) throw new Error(`Execution ${executionId} ClaimStore does not match the completed Claim checkpoints`);
  for (const row of stored) {
    const checkpoint = expected.get(row.claimId);
    if (!checkpoint || row.messageId !== checkpoint.messageId || row.policyId !== CLAIM_POLICY_ID
      || row.policyFingerprint !== CLAIM_POLICY_FINGERPRINT || row.reasoning === null) {
      throw new Error(`Execution ${executionId} ClaimStore identity or Policy does not match Claim ${row.claimId}`);
    }
    const durable = ClaimSchema.parse(storedClaimToClaim(row));
    if (canonicalJson(durable) !== canonicalJson(checkpoint.value)) {
      throw new Error(`Execution ${executionId} ClaimStore semantics do not match Claim checkpoint ${row.claimId}`);
    }
  }
}

function assertCurrentCounterpointParity(
  executionId: string,
  expectedByNode: readonly { nodeId: JudgeNodeId; messageId: string; counterpoints: readonly GroundedCounterpoint[] }[],
  stored: Awaited<ReturnType<JudgeReleaseStores['counterpoints']['getByRun']>>,
): void {
  const expected = new Map<string, { messageId: string; value: GroundedCounterpoint }>();
  for (const group of expectedByNode) {
    for (const counterpoint of group.counterpoints) {
      if (counterpoint.policyId !== COUNTERPOINT_POLICY_ID || counterpoint.policyFingerprint !== COUNTERPOINT_POLICY_FINGERPRINT) {
        throw new Error(`Current Counterpoint ${counterpoint.counterpointId} in ${executionId}/${group.nodeId} has unsupported Policy metadata`);
      }
      if (expected.has(counterpoint.counterpointId)) throw new Error(`Judge checkpoints contain duplicate Counterpoint ${counterpoint.counterpointId}`);
      expected.set(counterpoint.counterpointId, { messageId: group.messageId, value: counterpoint });
    }
  }
  if (stored.length !== expected.size) throw new Error(`Execution ${executionId} CounterpointStore does not match the completed Counterpoint checkpoints`);
  for (const row of stored) {
    const checkpoint = expected.get(row.counterpointId);
    if (!checkpoint || row.messageId !== checkpoint.messageId || row.policyId !== COUNTERPOINT_POLICY_ID
      || row.policyFingerprint !== COUNTERPOINT_POLICY_FINGERPRINT) {
      throw new Error(`Execution ${executionId} CounterpointStore identity or Policy does not match Counterpoint ${row.counterpointId}`);
    }
    const durable = storedCounterpointToCounterpoint(row);
    if (canonicalJson(durable) !== canonicalJson(checkpoint.value)) {
      throw new Error(`Execution ${executionId} CounterpointStore semantics do not match checkpoint ${row.counterpointId}`);
    }
  }
}

export interface JudgeReleasePlan {
  readonly executionId: string;
  readonly profileFingerprint: string;
  readonly releaseContractId: typeof JUDGE_RELEASE_CONTRACT_ID;
  readonly releaseContractFingerprint: typeof JUDGE_RELEASE_CONTRACT_FINGERPRINT;
  readonly graph: ClaimGraph;
  readonly graphFingerprint: string;
  readonly artifactProjections: readonly ClaimGraphArtifactProjection[];
  readonly contents: JudgeArtifactContents;
}

function createJudgeReleaseReceipt(execution: ResearchExecution, plan: JudgeReleasePlan, createdAt: string): ClaimGraphReleaseReceipt {
  return createClaimGraphReleaseReceipt({
    sessionId: execution.sessionId,
    turnId: execution.turnId,
    executionId: execution.id,
    ticker: execution.ticker,
    releaseContractId: plan.releaseContractId,
    releaseContractFingerprint: plan.releaseContractFingerprint,
    artifactGraphProjectionVersion: JUDGE_RELEASE_CONTRACT.artifactGraphProjectionVersion,
    claimGraphId: CLAIM_GRAPH_ID,
    claimGraphVersion: CLAIM_GRAPH_VERSION,
    claimGraphContractFingerprint: CLAIM_GRAPH_CONTRACT_FINGERPRINT,
    claimGraphFingerprint: plan.graphFingerprint,
    artifactProjections: plan.artifactProjections,
    createdAt,
  });
}

/** Validates the complete current Judge checkpoints and canonical graph before completion. */
export async function prepareJudgeReleasePlan(params: {
  stores: JudgeReleaseStores;
  execution: ResearchExecution;
  profile: ExecutionProfile;
}): Promise<JudgeReleasePlan> {
  const definition = createJudgeWorkflow();
  const plan = await planJudgeCheckpoint({
    stores: params.stores,
    execution: params.execution,
    profile: params.profile,
    definition,
    currentGraphFingerprint: judgeWorkflowGraphFingerprint(definition),
    requireCapabilityPlan: false,
  });
  if (plan.releaseKind !== 'current') throw new Error(`Execution ${params.execution.id} has a legacy Judge profile and cannot create a T5 release receipt`);
  const outputs = new Map(plan.outputs.map(output => [output.nodeId, output]));
  if (plan.outputs.length !== definition.nodes.length || definition.nodes.some(node => !outputs.has(node.id))) {
    throw new Error(`Execution ${params.execution.id} does not have a complete final Judge checkpoint set`);
  }
  for (const nodeId of ['collect-sources', 'round-1-bull-thesis', 'round-1-bear-challenge', 'round-2-bull-rebuttal', 'evaluate-arguments', 'synthesize-verdict'] as const) {
    requiredJudgeCheckpointOutput(outputs, nodeId);
  }
  const collected = restoredValue<CollectedSources>(plan, 'collect-sources');
  const thesis = restoredValue<ThesisTurn>(plan, 'round-1-bull-thesis');
  const challenge = restoredValue<ChallengeTurn>(plan, 'round-1-bear-challenge');
  const rebuttal = restoredValue<ThesisTurn>(plan, 'round-2-bull-rebuttal');
  const firstVerdict = restoredValue<JudgeTurn>(plan, 'evaluate-arguments');
  const synthesis = restoredValue<SynthesisTurn>(plan, 'synthesize-verdict');
  const conditionalEnabled = plan.reasoning || (plan.conditional && firstVerdict.needsExtra);
  for (const nodeId of ['conditional-bear-rechallenge', 'conditional-bull-rebuttal', 'resolve-conflicts'] as const) {
    const output = outputs.get(nodeId);
    if (!output || (conditionalEnabled ? output.status !== 'completed' : output.status !== 'skipped')) {
      throw new Error(`Judge release has an invalid ${nodeId} branch checkpoint status`);
    }
  }

  const conditionalBull = conditionalEnabled ? restoredValue<ThesisTurn>(plan, 'conditional-bull-rebuttal') : undefined;
  const conditionalBear = conditionalEnabled ? restoredValue<ChallengeTurn>(plan, 'conditional-bear-rechallenge') : undefined;
  const round1Parsed = parseCheckpointCounterpoints('round-1-bear-challenge', challenge.response, challenge.counterpoints, `${params.execution.id}/round-1-bear-challenge`);
  if (round1Parsed.kind !== 'current') throw new Error('Current Judge release contains a historical Counterpoint checkpoint');
  const counterpointGroups: Array<{ nodeId: JudgeNodeId; messageId: string; counterpoints: readonly GroundedCounterpoint[] }> = [{
    nodeId: 'round-1-bear-challenge', messageId: challenge.response.messageId, counterpoints: round1Parsed.counterpoints,
  }];
  if (conditionalBear) {
    const parsed = parseCheckpointCounterpoints('conditional-bear-rechallenge', conditionalBear.response, conditionalBear.counterpoints, `${params.execution.id}/conditional-bear-rechallenge`);
    if (parsed.kind !== 'current') throw new Error('Current Judge release contains a historical conditional Counterpoint checkpoint');
    counterpointGroups.push({ nodeId: 'conditional-bear-rechallenge', messageId: `${conditionalBear.response.messageId}_conditional`, counterpoints: parsed.counterpoints });
  }

  const claimGroups: Array<{ nodeId: JudgeNodeId; messageId: string; claims: readonly unknown[] }> = [
    { nodeId: 'round-1-bull-thesis', messageId: thesis.response.messageId, claims: thesis.claims },
    { nodeId: 'round-2-bull-rebuttal', messageId: rebuttal.response.messageId, claims: rebuttal.claims },
  ];
  if (conditionalBull) claimGroups.push({ nodeId: 'conditional-bull-rebuttal', messageId: `${conditionalBull.response.messageId}_conditional`, claims: conditionalBull.claims });
  const storedClaims = await params.stores.claims.getByRun(params.execution.id);
  const storedCounterpoints = await params.stores.counterpoints.getByRun(params.execution.id);
  assertCurrentClaimParity(params.execution.id, claimGroups, storedClaims);
  assertCurrentCounterpointParity(params.execution.id, counterpointGroups, storedCounterpoints);

  const graph = await params.stores.claimGraph.getByExecution(params.execution.id);
  const rebuiltGraph = buildClaimGraph({ executionId: params.execution.id, claims: storedClaims, counterpoints: storedCounterpoints });
  if (canonicalJson(graph) !== canonicalJson(rebuiltGraph)) throw new Error(`Execution ${params.execution.id} Claim Graph reader disagrees with canonical stores`);
  const graphFingerprint = claimGraphFingerprint(graph);
  const bullClaimIds = new Set([...thesis.claims, ...rebuttal.claims].map(claim => claim.claimId));
  const round1CounterpointIds = new Set(round1Parsed.counterpoints.map(point => point.counterpointId));
  const bullNodes = graph.nodes.filter((node): node is Extract<ClaimGraphNodeRef, { kind: 'claim' }> => node.kind === 'claim' && bullClaimIds.has(node.claimId));
  if (bullNodes.length !== bullClaimIds.size) throw new Error(`Execution ${params.execution.id} BULL_CASE graph projection omits a round-one or round-two Claim`);
  const bearEdges = graph.edges.filter(edge => round1CounterpointIds.has(edge.from.counterpointId));
  const bearNodesByKey = new Map<string, ClaimGraphNodeRef>();
  for (const edge of bearEdges) {
    bearNodesByKey.set(canonicalJson(edge.from), edge.from);
    bearNodesByKey.set(canonicalJson(edge.to), edge.to);
  }
  if (bearEdges.length !== round1CounterpointIds.size) throw new Error(`Execution ${params.execution.id} BEAR_CASE graph projection does not have one declared target edge per Counterpoint`);
  const artifactProjections: ClaimGraphArtifactProjection[] = [
    { kind: 'BULL_CASE', artifactId: `artifact_bull_case_${params.execution.id}`, nodes: bullNodes, edges: [] },
    { kind: 'BEAR_CASE', artifactId: `artifact_bear_case_${params.execution.id}`, nodes: [...bearNodesByKey.values()], edges: bearEdges },
    { kind: 'VERDICT', artifactId: `artifact_verdict_${params.execution.id}`, nodes: graph.nodes, edges: graph.edges },
  ];
  const contents: JudgeArtifactContents = {
    collected, thesis, challenge, rebuttal, synthesis,
    claimIds: storedClaims.map(claim => claim.claimId),
  };
  buildJudgeArtifactEnvelopes(params.execution, contents, params.execution.completedAt ?? params.execution.createdAt);
  const releasePlan: JudgeReleasePlan = {
    executionId: params.execution.id,
    profileFingerprint: params.profile.fingerprint,
    releaseContractId: JUDGE_RELEASE_CONTRACT_ID,
    releaseContractFingerprint: JUDGE_RELEASE_CONTRACT_FINGERPRINT,
    graph,
    graphFingerprint,
    artifactProjections,
    contents,
  };
  // Validate the receipt contract/projections before the Execution can settle.
  createJudgeReleaseReceipt(params.execution, releasePlan, params.execution.completedAt ?? params.execution.createdAt);
  return releasePlan;
}

/** Publishes validated artifacts and the insert-only receipt after completion. */
export async function publishJudgeRelease(params: {
  stores: JudgeReleaseStores;
  execution: ResearchExecution;
  profile: ExecutionProfile;
  plan: JudgeReleasePlan;
}): Promise<{ artifacts: ArtifactEnvelope[]; receipt: ClaimGraphReleaseReceipt }> {
  const { execution, profile, plan } = params;
  if (execution.status !== 'completed' || !execution.completedAt
    || execution.id !== plan.executionId || profile.executionId !== execution.id
    || profile.fingerprint !== plan.profileFingerprint || judgeReleaseKind(profile) !== 'current') {
    throw new Error(`Judge release publication identity or lifecycle state is invalid for Execution ${execution.id}`);
  }
  const envelopes = buildJudgeArtifactEnvelopes(execution, plan.contents, execution.completedAt);
  const savedArtifacts = await params.stores.artifacts.saveMany(envelopes);
  const receipt = createJudgeReleaseReceipt(execution, plan, execution.completedAt);
  const savedReceipt = await params.stores.claimGraphReleases.save(receipt);
  return { artifacts: savedArtifacts, receipt: savedReceipt };
}

