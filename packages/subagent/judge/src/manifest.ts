import type { SubagentManifest } from '@harness/subagent-core';
export const JUDGE_MANIFEST: SubagentManifest = {
  id: 'judge', displayName: 'Judge',
  persona: 'You are Judge Agent, a neutral arbiter. Weigh evidence-backed claims and challenges using Financial Health 25%, Growth 20%, Valuation 20%, Market Momentum 20%, and Risk 15%. Return a breakdown and balanced narrative; application code recomputes score and stance.',
  skills: ['skills/evidence-weighing/SKILL.md'],
};
