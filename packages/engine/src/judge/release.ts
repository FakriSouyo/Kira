import { canonicalJson, hasTransactionDirective, ValidationError } from '@harness/shared';
import {
  createJudgeWorkflow,
  JUDGE_RELEASE_CONTRACT,
  judgeWorkflowGraphFingerprint,
  JUDGE_RELEASE_CONTRACT_ID,
  JUDGE_RELEASE_CONTRACT_FINGERPRINT,
  JUDGE_RELEASE_CONTRACT_V1_ID,
  JUDGE_RELEASE_CONTRACT_V1_FINGERPRINT,
  type JudgeNodeId,
} from '@harness/command-judge';
import type { WorkflowNodeOutput, ArtifactStore, ExecutionProfile, ResearchExecution } from '@harness/session-core';
import { ArtifactEnvelopeSchema, ClaimSchema, type ArtifactEnvelope, type GroundedCounterpoint } from '@harness/schemas';
import {
  buildClaimGraph,
  claimGraphFingerprint,
  claimPolicyVersionForIdentity,
  CLAIM_GRAPH_CONTRACT_FINGERPRINT,
  CLAIM_GRAPH_ID,
  CLAIM_GRAPH_VERSION,
  counterpointPolicyVersionForIdentity,
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

function assertHumanTransactionAuthority(contents: JudgeArtifactContents): void {
  const claims = [...contents.thesis.claims, ...contents.rebuttal.claims].flatMap(claim => [
    claim.statement,
    claim.reasoning,
    ...(claim.evidenceLinks?.map(link => link.rationale) ?? []),
  ]);
  const counterpoints = contents.challenge.counterpoints.flatMap(counterpoint => [
    counterpoint.argument,
    ...('evidenceLinks' in counterpoint ? counterpoint.evidenceLinks.map(link => link.rationale) : []),
  ]);
  const text = [
    contents.thesis.response.reasoning,
    ...claims,
    contents.rebuttal.response.reasoning,
    contents.challenge.response.reasoning,
    ...counterpoints,
    contents.synthesis.judgment.summary,
  ];
  if (text.some(hasTransactionDirective)) {
    throw new ValidationError('Judge artifacts contain a transaction directive; transaction decisions belong to the human.');
  }
}

export function buildJudgeArtifactEnvelopes(execution: ResearchExecution, contents: JudgeArtifactContents, createdAt: string): ArtifactEnvelope[] {
  assertHumanTransactionAuthority(contents);
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
  policyVersion: 1 | 2,
  expectedByNode: readonly { nodeId: JudgeNodeId; messageId: string; claims: readonly unknown[] }[],
  stored: Awaited<ReturnType<JudgeReleaseStores['claims']['getByRun']>>,
): void {
  const expected = new Map<string, { messageId: string; value: ReturnType<typeof ClaimSchema.parse> }>();
  for (const group of expectedByNode) {
    for (const raw of group.claims) {
      const claim = ClaimSchema.parse(raw);
      if (claimPolicyVersionForIdentity(claim.policyId, claim.policyFingerprint) !== policyVersion) {
        throw new Error(`Current Claim ${claim.claimId} in ${executionId}/${group.nodeId} has unsupported Policy metadata`);
      }
      if (expected.has(claim.claimId)) throw new Error(`Judge checkpoints contain duplicate Claim ${claim.claimId}`);
      expected.set(claim.claimId, { messageId: group.messageId, value: claim });
    }
  }
  if (stored.length !== expected.size) throw new Error(`Execution ${executionId} ClaimStore does not match the completed Claim checkpoints`);
  for (const row of stored) {
    const checkpoint = expected.get(row.claimId);
    if (!checkpoint || row.messageId !== checkpoint.messageId
      || claimPolicyVersionForIdentity(row.policyId, row.policyFingerprint) !== policyVersion || row.reasoning === null) {
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
  policyVersion: 1 | 2,
  expectedByNode: readonly { nodeId: JudgeNodeId; messageId: string; counterpoints: readonly GroundedCounterpoint[] }[],
  stored: Awaited<ReturnType<JudgeReleaseStores['counterpoints']['getByRun']>>,
): void {
  const expected = new Map<string, { messageId: string; value: GroundedCounterpoint }>();
  for (const group of expectedByNode) {
    for (const counterpoint of group.counterpoints) {
      if (counterpointPolicyVersionForIdentity(counterpoint.policyId, counterpoint.policyFingerprint) !== policyVersion) {
        throw new Error(`Current Counterpoint ${counterpoint.counterpointId} in ${executionId}/${group.nodeId} has unsupported Policy metadata`);
      }
      if (expected.has(counterpoint.counterpointId)) throw new Error(`Judge checkpoints contain duplicate Counterpoint ${counterpoint.counterpointId}`);
      expected.set(counterpoint.counterpointId, { messageId: group.messageId, value: counterpoint });
    }
  }
  if (stored.length !== expected.size) throw new Error(`Execution ${executionId} CounterpointStore does not match the completed Counterpoint checkpoints`);
  for (const row of stored) {
    const checkpoint = expected.get(row.counterpointId);
    if (!checkpoint || row.messageId !== checkpoint.messageId
      || counterpointPolicyVersionForIdentity(row.policyId, row.policyFingerprint) !== policyVersion) {
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
  readonly policyVersion: 1 | 2;
  readonly releaseContractId: typeof JUDGE_RELEASE_CONTRACT_ID | typeof JUDGE_RELEASE_CONTRACT_V1_ID;
  readonly releaseContractFingerprint: typeof JUDGE_RELEASE_CONTRACT_FINGERPRINT | typeof JUDGE_RELEASE_CONTRACT_V1_FINGERPRINT;
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
    allowHistoricalPolicyV1: params.execution.status === 'completed',
  });
  if (plan.releaseKind === 'legacy') throw new Error(`Execution ${params.execution.id} has a legacy Judge profile and cannot create a T5 release receipt`);
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
  const round1Parsed = parseCheckpointCounterpoints('round-1-bear-challenge', challenge.response, challenge.counterpoints,
    `${params.execution.id}/round-1-bear-challenge`, plan.policyVersion === 1);
  if (round1Parsed.kind !== 'current') throw new Error('Current Judge release contains a historical Counterpoint checkpoint');
  const counterpointGroups: Array<{ nodeId: JudgeNodeId; messageId: string; counterpoints: readonly GroundedCounterpoint[] }> = [{
    nodeId: 'round-1-bear-challenge', messageId: challenge.response.messageId, counterpoints: round1Parsed.counterpoints,
  }];
  if (conditionalBear) {
    const parsed = parseCheckpointCounterpoints('conditional-bear-rechallenge', conditionalBear.response, conditionalBear.counterpoints,
      `${params.execution.id}/conditional-bear-rechallenge`, plan.policyVersion === 1);
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
  const storedVersions = [
    ...storedClaims.map(claim => claimPolicyVersionForIdentity(claim.policyId, claim.policyFingerprint)),
    ...storedCounterpoints.map(point => counterpointPolicyVersionForIdentity(point.policyId, point.policyFingerprint)),
  ];
  if (storedVersions.some(version => version === undefined)) {
    throw new Error(`Execution ${params.execution.id} has unknown stored Claim/Counterpoint policy metadata`);
  }
  const policyVersions = new Set<1 | 2>([
    ...(plan.policyVersion !== undefined ? [plan.policyVersion] : []),
    ...(storedVersions.filter((version): version is 1 | 2 => version !== undefined)),
  ]);
  if (policyVersions.size > 1) throw new Error(`Execution ${params.execution.id} mixes Claim/Counterpoint policy versions`);
  const storedPolicyVersion = policyVersions.values().next().value;
  if (plan.releaseKind === 'current' && storedPolicyVersion === 1) {
    throw new Error(`Current Judge profile ${params.execution.id} cannot release historical v1 policy state`);
  }
  if (plan.releaseKind === 'historical-v1'
    && (params.execution.status !== 'completed' || storedPolicyVersion === 2)) {
    throw new Error(`Historical v1 Judge profile ${params.execution.id} cannot release non-v1 or interrupted state`);
  }
  const historicalV1Release = plan.releaseKind === 'historical-v1';
  const policyVersion = storedPolicyVersion ?? (historicalV1Release ? 1 : 2);
  assertCurrentClaimParity(params.execution.id, policyVersion, claimGroups, storedClaims);
  assertCurrentCounterpointParity(params.execution.id, policyVersion, counterpointGroups, storedCounterpoints);

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
    policyVersion,
    releaseContractId: historicalV1Release ? JUDGE_RELEASE_CONTRACT_V1_ID : JUDGE_RELEASE_CONTRACT_ID,
    releaseContractFingerprint: historicalV1Release ? JUDGE_RELEASE_CONTRACT_V1_FINGERPRINT : JUDGE_RELEASE_CONTRACT_FINGERPRINT,
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
  const releaseKind = judgeReleaseKind(profile);
  const profileReleaseParity = releaseKind === 'current'
    ? plan.policyVersion === 2 && plan.releaseContractId === JUDGE_RELEASE_CONTRACT_ID
      && plan.releaseContractFingerprint === JUDGE_RELEASE_CONTRACT_FINGERPRINT
    : releaseKind === 'historical-v1'
      ? execution.status === 'completed' && plan.policyVersion === 1
        && plan.releaseContractId === JUDGE_RELEASE_CONTRACT_V1_ID
        && plan.releaseContractFingerprint === JUDGE_RELEASE_CONTRACT_V1_FINGERPRINT
      : false;
  if (execution.status !== 'completed' || !execution.completedAt
    || execution.id !== plan.executionId || profile.executionId !== execution.id
    || profile.fingerprint !== plan.profileFingerprint || !profileReleaseParity) {
    throw new Error(`Judge release publication identity or lifecycle state is invalid for Execution ${execution.id}`);
  }
  const envelopes = buildJudgeArtifactEnvelopes(execution, plan.contents, execution.completedAt);
  const savedArtifacts = await params.stores.artifacts.saveMany(envelopes);
  const receipt = createJudgeReleaseReceipt(execution, plan, execution.completedAt);
  const savedReceipt = await params.stores.claimGraphReleases.save(receipt);
  return { artifacts: savedArtifacts, receipt: savedReceipt };
}

