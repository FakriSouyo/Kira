import type { ArtifactEnvelope } from '@harness/schemas';
import type { ExecutionProfile, ResearchExecution, ResearchSessionStore } from '@harness/session-core';
import { judgeReleaseKind } from './checkpointResume.js';
import { prepareJudgeReleasePlan, publishJudgeRelease, type JudgeReleaseStores } from './release.js';
import { reconstructHistoricalJudgeArtifacts, type JudgeHistoricalArtifactStores } from './releaseReconciliation.js';

export type JudgeExecutionCompletionPhase = 'before-settlement' | 'after-settlement';

/** Identifies whether a completion failure happened before or after canonical settlement. */
export class JudgeExecutionCompletionError extends Error {
  constructor(
    readonly phase: JudgeExecutionCompletionPhase,
    cause: unknown,
    readonly execution?: ResearchExecution,
  ) {
    super(`Judge execution completion failed ${phase}`, { cause });
    this.name = 'JudgeExecutionCompletionError';
  }
}

export interface CompletedJudgeExecution {
  execution: ResearchExecution;
  artifacts: ArtifactEnvelope[];
}

/** Settles a lifecycle-backed Judge execution and publishes its profile-compatible artifacts. */
export async function completeJudgeExecution(params: {
  execution: ResearchExecution;
  profile: ExecutionProfile;
  executionTimeSeconds: number;
  sessions: Pick<ResearchSessionStore, 'settleExecution'>;
  releaseStores: JudgeReleaseStores;
  historicalArtifactStores: JudgeHistoricalArtifactStores;
}): Promise<CompletedJudgeExecution> {
  let releaseKind: ReturnType<typeof judgeReleaseKind>;
  let releasePlan: Awaited<ReturnType<typeof prepareJudgeReleasePlan>> | undefined;
  try {
    releaseKind = judgeReleaseKind(params.profile);
    if (releaseKind === 'current') {
      releasePlan = await prepareJudgeReleasePlan({
        stores: params.releaseStores,
        execution: params.execution,
        profile: params.profile,
      });
    }
  } catch (cause) {
    throw new JudgeExecutionCompletionError('before-settlement', cause);
  }

  let execution: ResearchExecution;
  try {
    execution = await params.sessions.settleExecution(params.execution.id, 'completed', {
      executionTimeSeconds: params.executionTimeSeconds,
    });
    if (execution.id !== params.execution.id || execution.status !== 'completed' || !execution.completedAt) {
      throw new Error(`Settlement did not return completed Judge Execution ${params.execution.id}`);
    }
  } catch (cause) {
    throw new JudgeExecutionCompletionError('before-settlement', cause);
  }

  try {
    const artifacts = releaseKind === 'current'
      ? (await publishJudgeRelease({
        stores: params.releaseStores,
        execution,
        profile: params.profile,
        plan: releasePlan!,
      })).artifacts
      : await reconstructHistoricalJudgeArtifacts({ stores: params.historicalArtifactStores, execution, profile: params.profile });
    return { execution, artifacts };
  } catch (cause) {
    throw new JudgeExecutionCompletionError('after-settlement', cause, execution);
  }
}
