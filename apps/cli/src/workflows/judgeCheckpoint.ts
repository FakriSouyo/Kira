import type { FinharnessDatabase } from '@harness/database';
import {
  reconcileCompletedJudgeReleases,
  type JudgeCheckpointStores,
  type JudgeReleaseReconciliationStores,
  type JudgeReleaseStores,
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

/** Adapts concrete database stores to the completed-release reconciliation contract. */
export function createJudgeReleaseReconciliationStores(db: FinharnessDatabase): JudgeReleaseReconciliationStores {
  return {
    ...createJudgeReleaseStores(db),
    sessions: db.sessions,
    executionProfiles: db.executionProfiles,
    artifacts: db.artifacts,
    claimGraphReleases: db.claimGraphReleases,
  };
}

/** Thin compatibility adapter retained for startup and existing CLI integration callers. */
export function repairCompletedJudgeReleases(params: {
  db: FinharnessDatabase;
  sessionId: string;
}): Promise<number> {
  return reconcileCompletedJudgeReleases({
    stores: createJudgeReleaseReconciliationStores(params.db),
    sessionId: params.sessionId,
  });
}

/** @deprecated Use repairCompletedJudgeReleases; retained for existing internal callers. */
export const repairCompletedJudgeArtifacts = repairCompletedJudgeReleases;
