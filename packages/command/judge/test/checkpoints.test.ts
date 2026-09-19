import { describe, expect, it } from 'vitest';
import { JUDGE_NODE_IDS } from '../src/definition.js';
import { JUDGE_CHECKPOINT_OUTPUT_KINDS, checkpointKindForNode } from '../src/checkpoints.js';

describe('Judge checkpoint contract', () => {
  it('assigns one stable versioned output kind to every production node', () => {
    const kinds = JUDGE_NODE_IDS.map(checkpointKindForNode);

    expect(kinds).toHaveLength(15);
    expect(new Set(kinds).size).toBe(15);
    expect(kinds).toEqual([
      'judge.company-report.v1',
      'judge.quarterly-financials.v1',
      'judge.market-data.v1',
      'judge.news-data.v1',
      'judge.collected-sources.v1',
      'judge.evidence-selection.v1',
      'judge.bull-thesis.v1',
      'judge.bear-challenge.v1',
      'judge.bull-rebuttal.v1',
      'judge.evaluation.v1',
      'judge.conditional-bear.v1',
      'judge.conditional-bull.v1',
      'judge.resolution.v1',
      'judge.evidence-audit.v1',
      'judge.verdict.v1',
    ]);
    expect(JUDGE_CHECKPOINT_OUTPUT_KINDS['fetch-market-data']).toBe('judge.market-data.v1');
  });
});
