import { describe, expect, it } from 'vitest';
import {
  createJudgeCommandContext, createJudgeWorkflow,
  JUDGE_NODE_IDS, JUDGE_SERVICES, JUDGE_SUBAGENTS,
  type JudgeNodeExecutors, type JudgeRoundDecision,
} from '../src/index.js';

const executors = (log: string[]): JudgeNodeExecutors => Object.fromEntries(
  JUDGE_NODE_IDS.map((nodeId) => [nodeId, async () => { log.push(nodeId); return nodeId; }]),
) as unknown as JudgeNodeExecutors;

describe('/judge workflow definition', () => {
  it('declares the reconciled production nodes in execution order', () => {
    const definition = createJudgeWorkflow();
    expect(definition.id).toBe('judge');
    expect(definition.nodes.map((node) => node.id)).toEqual(JUDGE_NODE_IDS);
    expect(definition.nodes).toHaveLength(15);
  });

  it('binds every declared node to a reasoning role or a real service', () => {
    expect(JUDGE_SUBAGENTS).toEqual(['researcher', 'bull', 'bear', 'judge']);
    expect(JUDGE_SERVICES).toEqual(['sectors-api', 'bull-input', 'claim-validator', 'deterministic-rubric']);
    const owners = createJudgeWorkflow().nodes.map((node) => node.executor!);
    expect(new Set(owners.filter((owner) => owner.kind === 'subagent').map((owner) => owner.id))).toEqual(new Set(JUDGE_SUBAGENTS));
    expect(new Set(owners.filter((owner) => owner.kind === 'service').map((owner) => owner.id))).toEqual(new Set(JUDGE_SERVICES));
    expect(owners).not.toContainEqual(expect.objectContaining({ id: 'fundamentals' }));
    expect(owners).not.toContainEqual(expect.objectContaining({ id: 'valuation' }));
    expect(owners).not.toContainEqual(expect.objectContaining({ id: 'risk' }));
  });

  it('executes each node through its adapter in dependency order', async () => {
    const log: string[] = [];
    const definition = createJudgeWorkflow();
    const context = createJudgeCommandContext({
      reasoningMode: 'usual', conditional: false,
      researchers: { market: true, news: true }, executors: executors(log),
    });
    for (const node of definition.nodes) await node.run(context, {}, undefined);
    expect(log).toEqual([...JUDGE_NODE_IDS]);
  });

  it('gates enrichment fetches by the research profile and the arbitration round by the verdict', () => {
    const nodes = createJudgeWorkflow().nodes;
    const enabled = (id: string) => nodes.find((node) => node.id === id)!.enabled;
    expect(nodes.filter((node) => node.enabled).map((node) => node.id)).toEqual([
      'fetch-market-data', 'fetch-news',
      'conditional-bear-rechallenge', 'conditional-bull-rebuttal', 'resolve-conflicts',
    ]);
    const decision: JudgeRoundDecision = {};
    const gate = (reasoningMode: 'usual' | 'reasoning', conditional: boolean, researchers = { market: true, news: true }) =>
      createJudgeCommandContext({ reasoningMode, conditional, researchers, executors: executors([]), decision });

    // The research profile skips a disabled source instead of grading absent evidence.
    expect(enabled('fetch-market-data')!(gate('usual', false, { market: false, news: true }))).toBe(false);
    expect(enabled('fetch-news')!(gate('usual', false, { market: true, news: false }))).toBe(false);
    expect(enabled('fetch-market-data')!(gate('usual', false))).toBe(true);

    // The arbitration round needs Reasoning mode, or an inconclusive round-1 verdict under --conditional.
    expect(enabled('conditional-bear-rechallenge')!(gate('usual', false))).toBe(false);
    expect(enabled('conditional-bear-rechallenge')!(gate('usual', true))).toBe(false);
    expect(enabled('resolve-conflicts')!(gate('reasoning', false))).toBe(true);
    decision.extraRound = true;
    expect(enabled('conditional-bear-rechallenge')!(gate('usual', false))).toBe(false);
    expect(enabled('conditional-bull-rebuttal')!(gate('usual', true))).toBe(true);
    expect(enabled('resolve-conflicts')!(gate('usual', true))).toBe(true);

    // Evidence collection and the debate itself are never optional.
    expect(enabled('round-1-bull-thesis')).toBeUndefined();
    expect(enabled('round-2-bull-rebuttal')).toBeUndefined();
    expect(enabled('check-evidence')).toBeUndefined();
  });

  it('keeps evidence and determinism gates after the debate they audit', () => {
    const nodes = createJudgeWorkflow().nodes;
    const depends = (id: string) => nodes.find((node) => node.id === id)!.dependsOn!;
    expect(depends('round-1-bear-challenge')).toContain('round-1-bull-thesis');
    expect(depends('round-2-bull-rebuttal')).toContain('round-1-bear-challenge');
    expect(depends('conditional-bear-rechallenge')).toContain('evaluate-arguments');
    expect(depends('conditional-bull-rebuttal')).toEqual(['conditional-bear-rechallenge', 'select-supporting-evidence']);
    expect(depends('resolve-conflicts')).toEqual(['round-1-bull-thesis', 'round-2-bull-rebuttal', 'conditional-bull-rebuttal', 'select-supporting-evidence']);
    expect(depends('check-evidence')).toEqual([
      'select-supporting-evidence', 'round-1-bull-thesis', 'round-1-bear-challenge', 'round-2-bull-rebuttal',
      'conditional-bear-rechallenge', 'conditional-bull-rebuttal', 'resolve-conflicts',
    ]);
    expect(depends('synthesize-verdict')).toEqual(['evaluate-arguments', 'resolve-conflicts', 'check-evidence']);
  });

  it('requires every declared node to be bound by an adapter', () => {
    expect(Object.keys(executors([]))).toEqual([...JUDGE_NODE_IDS]);
  });
});
