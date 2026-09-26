import { createJudgeWorkflow, judgeWorkflowGraphFingerprint } from '@harness/command-judge';
import type { ArtifactEnvelope } from '@harness/schemas';
import type { FinharnessDatabase } from '@harness/database';
import type { ExecutionProfile, ResearchExecution } from '@harness/session-core';
import {
  buildJudgeArtifactEnvelopes,
  decodeJudgeCheckpoint,
  judgeReleaseKind,
  planJudgeCheckpoint,
  prepareJudgeReleasePlan,
  publishJudgeRelease,
  requiredJudgeCheckpointOutput,
  type ChallengeTurn,
  type CollectedSources,
  type JudgeCheckpointStores,
  type JudgeReleaseStores,
  type SynthesisTurn,
  type ThesisTurn,
} from '@harness/engine';

function checkpointStores(db: FinharnessDatabase): JudgeCheckpointStores {
  return {
    workflowNodeOutputs: db.workflowNodeOutputs,
    financialSnapshots: db.financialSnapshots,
    evidence: db.evidence,
    contextSnapshots: db.contextSnapshots,
  };
}

/** Adapts CLI database-owned stores to the host-neutral current release contract. */
export function createJudgeReleaseStores(db: FinharnessDatabase): JudgeReleaseStores {
  return {
    ...checkpointStores(db),
    claims: db.claims,
    counterpoints: db.counterpoints,
    claimGraph: db.claimGraph,
    artifacts: db.artifacts,
    claimGraphReleases: db.claimGraphReleases,
  };
}
/** Rebuilds the three immutable Judge artifacts from validated node checkpoints. */
export async function ensureJudgeArtifacts(params: {
  db: FinharnessDatabase;
  execution: ResearchExecution;
  profile: ExecutionProfile;
}): Promise<ArtifactEnvelope[]> {
  const definition = createJudgeWorkflow();
  const stores = checkpointStores(params.db);
  const plan = await planJudgeCheckpoint({
    stores,
    execution: params.execution,
    profile: params.profile,
    definition,
    currentGraphFingerprint: judgeWorkflowGraphFingerprint(definition),
    requireCapabilityPlan: false,
  });
  const outputs = new Map(plan.outputs.map(output => [output.nodeId, output]));
  const collected = await decodeJudgeCheckpoint('collect-sources', requiredJudgeCheckpointOutput(outputs, 'collect-sources'), stores, params.execution) as CollectedSources;
  const thesis = await decodeJudgeCheckpoint('round-1-bull-thesis', requiredJudgeCheckpointOutput(outputs, 'round-1-bull-thesis'), stores, params.execution) as ThesisTurn;
  const challenge = await decodeJudgeCheckpoint('round-1-bear-challenge', requiredJudgeCheckpointOutput(outputs, 'round-1-bear-challenge'), stores, params.execution) as ChallengeTurn;
  const rebuttal = await decodeJudgeCheckpoint('round-2-bull-rebuttal', requiredJudgeCheckpointOutput(outputs, 'round-2-bull-rebuttal'), stores, params.execution) as ThesisTurn;
  const synthesis = await decodeJudgeCheckpoint('synthesize-verdict', requiredJudgeCheckpointOutput(outputs, 'synthesize-verdict'), stores, params.execution) as SynthesisTurn;
  const storedClaims = await params.db.claims.getByRun(params.execution.id);
  const createdAt = params.execution.completedAt ?? new Date().toISOString();
  return await params.db.artifacts.saveMany(buildJudgeArtifactEnvelopes(params.execution, {
    collected, thesis, challenge, rebuttal, synthesis, claimIds: storedClaims.map(claim => claim.claimId),
  }, createdAt));
}

/** Repairs or validates completed lifecycle Judge releases before startup publication. */
export async function repairCompletedJudgeReleases(params: {
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
    if (judgeReleaseKind(profile) === 'current') {
      const releasePlan = await prepareJudgeReleasePlan({ stores: createJudgeReleaseStores(params.db), execution, profile });
      const receipt = existing.length === 3
        ? await params.db.claimGraphReleases.getByExecution(execution.id)
        : null;
      await publishJudgeRelease({ stores: createJudgeReleaseStores(params.db), execution, profile, plan: releasePlan });
      if (existing.length !== 3 || receipt === null) repaired += 1;
      continue;
    }
    if (existing.length === 3) continue;
    await ensureJudgeArtifacts({ db: params.db, execution, profile });
    repaired += 1;
  }
  return repaired;
}

/** @deprecated Use repairCompletedJudgeReleases; retained for existing internal callers. */
export const repairCompletedJudgeArtifacts = repairCompletedJudgeReleases;
