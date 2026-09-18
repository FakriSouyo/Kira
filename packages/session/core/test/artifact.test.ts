import { describe, expect, it } from 'vitest';
import { deriveWorkingContextPatch, type DurableArtifactRef } from '@harness/session-core';

const durable = (kind: DurableArtifactRef['kind'], artifactId: string): DurableArtifactRef => ({ kind, artifactId });

describe('PR F artifact references in working context', () => {
  it('publishes only references for artifact kinds that actually exist', () => {
    const patch = deriveWorkingContextPatch({
      command: 'judge',
      executions: [{ executionId: 'run_1', ticker: 'BBCA', command: 'judge' }],
      judgedExecutionIds: [],
      artifactRefs: [durable('BULL_CASE', 'artifact_bull_case_run_1'), durable('BEAR_CASE', 'artifact_bear_case_run_1'), durable('VERDICT', 'artifact_verdict_run_1')],
    });

    expect(patch).toMatchObject({
      currentIntent: { command: 'judge' },
      activeSubjects: [{ ticker: 'BBCA' }],
      activeBullCaseRef: durable('BULL_CASE', 'artifact_bull_case_run_1'),
      activeBearCaseRef: durable('BEAR_CASE', 'artifact_bear_case_run_1'),
      activeVerdictRef: durable('VERDICT', 'artifact_verdict_run_1'),
    });
    expect(patch.activeThesisRef).toBeUndefined();
  });

  it('keeps PR D legacy judgment references derivable for old rows', () => {
    expect(deriveWorkingContextPatch({
      command: 'judge',
      executions: [{ executionId: 'run_legacy', ticker: 'BBRI', command: 'judge' }],
      judgedExecutionIds: ['run_legacy'],
    }).activeVerdictRef).toEqual({ kind: 'judgment', executionId: 'run_legacy' });
  });

  it('does not invent missing artifact references', () => {
    const patch = deriveWorkingContextPatch({
      command: 'judge', executions: [{ executionId: 'run_1', ticker: 'BBCA', command: 'judge' }], judgedExecutionIds: [], artifactRefs: [],
    });
    expect(patch.activeThesisRef).toBeUndefined();
    expect(patch.activeBullCaseRef).toBeUndefined();
    expect(patch.activeBearCaseRef).toBeUndefined();
    expect(patch.activeVerdictRef).toBeUndefined();
  });
});
