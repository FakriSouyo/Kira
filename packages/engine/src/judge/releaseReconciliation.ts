import { createJudgeWorkflow, judgeWorkflowGraphFingerprint } from '@harness/command-judge';
import type { ClaimGraphReleaseStore } from '@harness/execution';
import type { ArtifactStore, ExecutionProfile, ExecutionProfileStore, ResearchExecution, ResearchSessionStore } from '@harness/session-core';
import type { ArtifactEnvelope } from '@harness/schemas';
import {
  decodeJudgeCheckpoint,
  judgeReleaseKind,
  planJudgeCheckpoint,
  type JudgeCheckpointReadStores,
} from './checkpointResume.js';
import type { ChallengeTurn, CollectedSources, SynthesisTurn, ThesisTurn } from './nodeRuntime.js';
import { buildJudgeArtifactEnvelopes, prepareJudgeReleasePlan, publishJudgeRelease, requiredJudgeCheckpointOutput, type JudgeReleaseStores } from './release.js';

/** Narrow host-supplied operations for reconciling completed Judge releases. */
export interface JudgeReleaseReconciliationStores extends JudgeReleaseStores {
  readonly sessions: Pick<ResearchSessionStore, 'getSessionArtifacts'>;
  readonly executionProfiles: Pick<ExecutionProfileStore, 'getByExecutionId'>;
  readonly artifacts: Pick<ArtifactStore, 'getByExecution' | 'saveMany'>;
  readonly claimGraphReleases: Pick<ClaimGraphReleaseStore, 'getByExecution' | 'save'>;
}

/** Minimum supplied reads and write needed to reconstruct historical artifacts. */
export type JudgeHistoricalArtifactStores = JudgeCheckpointReadStores
  & Pick<JudgeReleaseStores, 'claims'>
  & { readonly artifacts: Pick<ArtifactStore, 'saveMany'> };

/** Rebuilds historical Judge artifacts from validated checkpoint output without creating a T5 receipt. */
export async function reconstructHistoricalJudgeArtifacts(params: {
  stores: JudgeHistoricalArtifactStores;
  execution: ResearchExecution;
  profile: ExecutionProfile;
}): Promise<ArtifactEnvelope[]> {
  const definition = createJudgeWorkflow();
  const plan = await planJudgeCheckpoint({
    stores: params.stores,
    execution: params.execution,
    profile: params.profile,
    definition,
    currentGraphFingerprint: judgeWorkflowGraphFingerprint(definition),
    requireCapabilityPlan: false,
  });
  if (plan.releaseKind === 'current') {
    throw new Error(`Execution ${params.execution.id} has a current Judge release and cannot use historical artifact reconstruction`);
  }
  const outputs = new Map(plan.outputs.map(output => [output.nodeId, output]));
  const collected = await decodeJudgeCheckpoint(
    'collect-sources', requiredJudgeCheckpointOutput(outputs, 'collect-sources'), params.stores, params.execution,
  ) as CollectedSources;
  const thesis = await decodeJudgeCheckpoint(
    'round-1-bull-thesis', requiredJudgeCheckpointOutput(outputs, 'round-1-bull-thesis'), params.stores, params.execution,
  ) as ThesisTurn;
  const challenge = await decodeJudgeCheckpoint(
    'round-1-bear-challenge', requiredJudgeCheckpointOutput(outputs, 'round-1-bear-challenge'), params.stores, params.execution,
  ) as ChallengeTurn;
  const rebuttal = await decodeJudgeCheckpoint(
    'round-2-bull-rebuttal', requiredJudgeCheckpointOutput(outputs, 'round-2-bull-rebuttal'), params.stores, params.execution,
  ) as ThesisTurn;
  const synthesis = await decodeJudgeCheckpoint(
    'synthesize-verdict', requiredJudgeCheckpointOutput(outputs, 'synthesize-verdict'), params.stores, params.execution,
  ) as SynthesisTurn;
  const storedClaims = await params.stores.claims.getByRun(params.execution.id);
  const createdAt = params.execution.completedAt ?? new Date().toISOString();
  return params.stores.artifacts.saveMany(buildJudgeArtifactEnvelopes(params.execution, {
    collected,
    thesis,
    challenge,
    rebuttal,
    synthesis,
    claimIds: storedClaims.map(claim => claim.claimId),
  }, createdAt));
}

/** Reconciles already-completed Judge releases for one Session without re-running Judge. */
export async function reconcileCompletedJudgeReleases(params: {
  stores: JudgeReleaseReconciliationStores;
  sessionId: string;
}): Promise<number> {
  const sessionArtifacts = await params.stores.sessions.getSessionArtifacts(params.sessionId);
  let repaired = 0;
  for (const execution of sessionArtifacts.executions) {
    if (execution.command !== 'judge' || execution.status !== 'completed') continue;
    const profile = await params.stores.executionProfiles.getByExecutionId(execution.id);
    if (!profile || profile.workflowId !== 'judge' || profile.workflowVersion !== 2) continue;
    const existing = await params.stores.artifacts.getByExecution(execution.id);
    if (judgeReleaseKind(profile) === 'current') {
      const releasePlan = await prepareJudgeReleasePlan({ stores: params.stores, execution, profile });
      const receipt = existing.length === 3
        ? await params.stores.claimGraphReleases.getByExecution(execution.id)
        : null;
      await publishJudgeRelease({ stores: params.stores, execution, profile, plan: releasePlan });
      if (existing.length !== 3 || receipt === null) repaired += 1;
      continue;
    }
    if (existing.length === 3) continue;
    await reconstructHistoricalJudgeArtifacts({ stores: params.stores, execution, profile });
    repaired += 1;
  }
  return repaired;
}

