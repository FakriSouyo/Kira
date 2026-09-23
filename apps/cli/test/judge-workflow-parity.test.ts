import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { WorkflowRunner } from '@harness/command-core';
import { createJudgeWorkflow, JUDGE_NODE_IDS } from '@harness/command-judge';
import { buildContext } from '../src/context';
import { loadConfig } from '../src/config';
import { judgeWorkflow } from '../src/workflows/judgeWorkflow';
import { createJudgeNodeExecutors } from '../src/workflows/judgeNodes';
import type { AgentEvent } from '../src/repl/events';

type StepEvent = Extract<AgentEvent, { type: 'workflow.step' }>;

/**
 * PR C parity: production `/judge` executes through `WorkflowRunner`
 * (`packages/command/core`), and every characterized guarantee of the former
 * manual pipeline — evidence, validation, debate rounds, deterministic verdict,
 * lifecycle, cancellation, prompt-cache zone — stays intact.
 */
describe('/judge runs through the workflow runtime (PR C)', () => {
  let homeDir: string;
  let db: FinharnessDatabase;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-judge-parity-'));
    db = openDb({ homeDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  const ctx = () => buildContext(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }), { sessionId: 'judge-parity-test-session' });
  const steps = (events: AgentEvent[]): StepEvent[] => events.filter((event): event is StepEvent => event.type === 'workflow.step');
  const runIdOf = (events: AgentEvent[]): string => {
    const start = events.find((event): event is Extract<AgentEvent, { type: 'session.start' }> => event.type === 'session.start');
    if (!start) throw new Error('run did not emit session.start');
    return start.runId;
  };

  it('executes production /judge through WorkflowRunner as the only execution truth', async () => {
    const context = ctx();
    const run = vi.spyOn(WorkflowRunner.prototype, 'run');
    const analyze = vi.spyOn(context.bull, 'analyze');
    const challenge = vi.spyOn(context.bear, 'challenge');
    const rebuttal = vi.spyOn(context.bull, 'rebuttal');
    const evaluate = vi.spyOn(context.judge, 'evaluate');

    await judgeWorkflow(context, 'BBCA');

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ id: 'judge' });
    // The runner is the only driver: each debate stage runs exactly once, so no
    // manual second implementation can be hiding behind the workflow.
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(challenge).toHaveBeenCalledTimes(1);
    expect(rebuttal).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('keeps one provider operation per selected /judge source', async () => {
    const context = ctx();
    const methods = [
      'getCompanyReport', 'getQuarterlyFinancials', 'getDailyTransaction',
      'getForeignFlow', 'getNews', 'getFilings', 'getSentiment',
    ] as const;
    const calls = methods.map(method => vi.spyOn(context.financialData, method));

    await judgeWorkflow(context, 'BBCA');

    expect(calls.map(call => call.mock.calls.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('keeps quarterly financials as a required provider failure', async () => {
    const context = ctx();
    const events: AgentEvent[] = [];
    vi.spyOn(context.financialData, 'getQuarterlyFinancials').mockRejectedValue(new Error('Quarterly data unavailable'));

    await expect(judgeWorkflow(context, 'BBCA', () => {}, event => events.push(event)))
      .rejects.toThrow('Quarterly data unavailable');
    expect(events).toContainEqual(expect.objectContaining({ type: 'session.complete', status: 'failed' }));
  });

  it('keeps market data as optional enrichment when the provider fails', async () => {
    const context = ctx();
    const events: AgentEvent[] = [];
    vi.spyOn(context.financialData, 'getDailyTransaction').mockRejectedValue(new Error('Market data unavailable'));

    const artifacts = await judgeWorkflow(context, 'BBCA', () => {}, event => events.push(event));

    expect(artifacts.run.status).toBe('completed');
    expect(artifacts.marketAvailable).toBe(false);
    expect(artifacts.marketEvidence).toEqual([]);
    expect(artifacts.judgment.breakdown.marketMomentum).toBeNull();
    expect(steps(events).filter(event => event.status === 'failed').map(event => event.nodeId)).toEqual(['fetch-market-data']);
  });

  it('projects every declared node into the canonical step stream and persists the trace', async () => {
    const context = ctx();
    const events: AgentEvent[] = [];
    const artifacts = await judgeWorkflow(context, 'BBCA', () => {}, (event) => events.push(event));

    const projected = steps(events);
    const definition = createJudgeWorkflow();
    // Each node emits at least one event; first appearance follows graph order, so
    // no declared node can be missing from the runtime stream.
    expect([...new Set(projected.map((event) => event.nodeId))]).toEqual([...JUDGE_NODE_IDS]);
    for (const event of projected) {
      expect(event.workflowId).toBe('judge');
      expect(event.parentIds).toEqual(definition.nodes.find((node) => node.id === event.nodeId)!.dependsOn ?? []);
      expect(event.owner).toBeTruthy();
      expect(['running', 'completed', 'skipped', 'failed', 'cancelled']).toContain(event.status);
    }
    // Nothing decorative: every node either ran or was explicitly skipped by profile.
    expect(projected.filter((event) => event.status === 'running')).toHaveLength(12);
    expect(projected.filter((event) => event.status === 'completed')).toHaveLength(12);
    expect(projected.filter((event) => event.status === 'skipped').map((event) => event.nodeId)).toEqual([
      'conditional-bear-rechallenge', 'conditional-bull-rebuttal', 'resolve-conflicts',
    ]);

    const rows = db.raw.prepare('SELECT node_id FROM workflow_steps WHERE run_id = ?').all(artifacts.run.id) as Array<{ node_id: string }>;
    expect(new Set(rows.map((row) => row.node_id))).toEqual(new Set(JUDGE_NODE_IDS));
    // The trace subscriber recorded the subagent result (skills/summary) on the node
    // step. Model-call rows only appear when the provider reports usage metadata,
    // which the mock LLM does not — that path is covered by the recorder unit test.
    const judgeStep = db.raw.prepare("SELECT status, summary FROM workflow_steps WHERE run_id = ? AND node_id = 'evaluate-arguments'").get(artifacts.run.id) as { status: string; summary: string | null };
    expect(judgeStep.status).toBe('completed');
    expect(judgeStep.summary).toBeTruthy();
  });

  it('runs the debate in dependency order, with gates after the nodes they audit', async () => {
    const context = ctx();
    const events: AgentEvent[] = [];
    await judgeWorkflow(context, 'BBCA', () => {}, (event) => events.push(event));

    const order = steps(events).filter((event) => event.status === 'completed').map((event) => event.nodeId);
    expect(order).toEqual([
      'identify-company', 'fetch-financials', 'fetch-market-data', 'fetch-news', 'collect-sources',
      'select-supporting-evidence', 'round-1-bull-thesis', 'round-1-bear-challenge', 'round-2-bull-rebuttal',
      'evaluate-arguments', 'check-evidence', 'synthesize-verdict',
    ]);
    expect(order.indexOf('check-evidence')).toBeLessThan(order.indexOf('synthesize-verdict'));
  });

  it('persists the same evidence and conversation artifacts as the manual pipeline', async () => {
    const context = ctx();
    const artifacts = await judgeWorkflow(context, 'BBCA');

    const evidence = db.raw.prepare('SELECT source FROM evidence WHERE run_id = ? ORDER BY created_at').all(artifacts.run.id) as Array<{ source: string }>;
    expect(evidence.map((row) => row.source)).toEqual([
      'sectors.company_report', 'sectors.quarterly_financials', 'sectors.daily_transaction',
      'sectors.foreign_flow', 'sectors.news', 'sectors.filings', 'sectors.sentiment',
    ]);
    expect(artifacts.evidence).toHaveLength(2);
    expect(artifacts.marketEvidence).toHaveLength(2);
    expect(artifacts.newsEvidence).toHaveLength(3);
    expect(artifacts.marketAvailable).toBe(true);
    expect(artifacts.newsAvailable).toBe(true);

    const messages = await db.conversation.getByRun(artifacts.run.id);
    expect(messages.map((message) => ({ agent: message.agent, type: message.messageType, order: message.sequenceOrder }))).toEqual([
      { agent: 'researcher', type: 'observation', order: 0 },
      { agent: 'bull', type: 'claim', order: 1 },
      { agent: 'bear', type: 'challenge', order: 2 },
      { agent: 'bull', type: 'response', order: 3 },
      { agent: 'judge', type: 'decision', order: 4 },
    ]);
    const claims = await db.claims.getByRun(artifacts.run.id);
    expect(claims.filter((claim) => claim.claimId.startsWith('rebuttal_')).length).toBeGreaterThan(0);
    expect(await db.judgments.getByRun(artifacts.run.id)).toMatchObject({
      stance: artifacts.judgment.stance, score: artifacts.judgment.score,
    });
  });

  it('keeps the seen-evidence rule inside the runtime: unseen citations fail before persistence', async () => {
    const context = ctx();
    const events: AgentEvent[] = [];
    const analyze = context.bull.analyze.bind(context.bull);
    vi.spyOn(context.bull, 'analyze').mockImplementation(async (args) => {
      const result = await analyze(args);
      return { ...result, value: { ...result.value, evidenceIds: ['ev_never_seen'] } };
    });

    await expect(judgeWorkflow(context, 'BBCA', () => {}, (event) => events.push(event)))
      .rejects.toMatchObject({ code: 'EVIDENCE_HALLUCINATION' });

    const runId = runIdOf(events);
    expect(await db.claims.getByRun(runId)).toEqual([]);
    expect((db.raw.prepare('SELECT status FROM executions WHERE id = ?').get(runId) as { status: string }).status).toBe('failed');
    const failedStep = steps(events).find((event) => event.status === 'failed');
    expect(failedStep?.nodeId).toBe('round-1-bull-thesis');
  });

  it('keeps numeric grounding enforcement inside the runtime node', async () => {
    const context = ctx();
    const events: AgentEvent[] = [];
    const analyze = context.bull.analyze.bind(context.bull);
    vi.spyOn(context.bull, 'analyze').mockImplementation(async (args) => {
      const result = await analyze(args);
      const evidenceId = result.value.claims[0].evidenceIds[0];
      return {
        ...result,
        value: {
          ...result.value,
          claims: [...result.value.claims, {
            claimId: 'claim_grounding_probe',
            statement: 'Crafted grounding probe for the numeric path check.',
            confidence: 'moderate' as const,
            reasoning: 'This claim cites a figure path that does not exist in the evidence payload.',
            evidenceIds: [evidenceId],
            evidenceLinks: [{ evidenceId, relation: 'supports' as const, rationale: 'Probes numeric path validation.' }],
            citedFigures: [{ evidenceId, path: 'financials.roe_missing_path', value: 1, periodLabel: 'FY' }],
          }],
        },
      };
    });

    await expect(judgeWorkflow(context, 'BBCA', () => {}, (event) => events.push(event)))
      .rejects.toMatchObject({ code: 'EVIDENCE_HALLUCINATION' });
    expect(await db.claims.getByRun(runIdOf(events))).toEqual([]);
  });

  it('degrades an optional enrichment failure visibly without failing the run', async () => {
    const context = ctx();
    const events: AgentEvent[] = [];
    vi.spyOn(context.financialData, 'getNews').mockRejectedValue(new Error('News unavailable'));

    const artifacts = await judgeWorkflow(context, 'BBCA', () => {}, (event) => events.push(event));

    expect(artifacts.run.status).toBe('completed');
    expect(artifacts.newsAvailable).toBe(false);
    expect(artifacts.newsEvidence).toEqual([]);
    expect(artifacts.judgment.breakdown.risk).toBeNull();
    expect(artifacts.judgment.breakdown.marketMomentum).not.toBeNull();
    const failed = steps(events).filter((event) => event.status === 'failed');
    expect(failed.map((event) => event.nodeId)).toEqual(['fetch-news']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'command.output', text: expect.stringContaining('News data unavailable') }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.complete', tool: 'news', error: 'News unavailable' }));
  });

  it('fails the run when persisting optional-stage evidence fails', async () => {
    const context = ctx();
    const accept = context.db.evidence.accept.bind(context.db.evidence);
    vi.spyOn(context.db.evidence, 'accept').mockImplementation((params) => {
      if (params.source === 'sectors.daily_transaction') throw new Error('Database unavailable');
      return accept(params);
    });

    await expect(judgeWorkflow(context, 'BBRI')).rejects.toThrow('Database unavailable');
  });

  it('opens the arbitration round only in Reasoning mode or for --conditional + neutral', async () => {
    const usual = await judgeWorkflow(ctx(), 'BBCA');
    expect(usual.conditionalUsed).toBe(false);
    expect(await db.conversation.getByRun(usual.run.id)).toHaveLength(5);

    const reasoningCtx = ctx();
    const reasoningEvents: AgentEvent[] = [];
    const reasoning = await judgeWorkflow(reasoningCtx, 'BBRI', () => {}, (event) => reasoningEvents.push(event), { reasoning: true });
    expect(reasoning.conditionalUsed).toBe(true);
    const messages = await db.conversation.getByRun(reasoning.run.id);
    expect(messages.map((message) => message.sequenceOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(steps(reasoningEvents).filter((event) => event.nodeId === 'resolve-conflicts' && event.status === 'completed')).toHaveLength(1);
  });

  it('feeds the Bear counterpoints into the Bull rebuttal and persists the challenge text', async () => {
    const context = ctx();
    const captured: Array<readonly { targetClaimId: string }[]> = [];
    const rebuttal = context.bull.rebuttal.bind(context.bull);
    vi.spyOn(context.bull, 'rebuttal').mockImplementation(async (args) => {
      captured.push(args.bearCounterpoints);
      return rebuttal(args);
    });

    const artifacts = await judgeWorkflow(context, 'BBCA');

    expect(captured).toHaveLength(1);
    expect(captured[0].length).toBe(artifacts.bear.counterpoints.length);
    const challengeMessage = (await db.conversation.getByRun(artifacts.run.id)).find((message) => message.messageType === 'challenge')!;
    expect(challengeMessage.content).toContain(`targets claim ${captured[0][0].targetClaimId}`);
  });

  it('rejects a verdict whose score contradicts the deterministic rubric', async () => {
    const context = ctx();
    const events: AgentEvent[] = [];
    const evaluate = context.judge.evaluate.bind(context.judge);
    vi.spyOn(context.judge, 'evaluate').mockImplementation(async (args) => {
      const result = await evaluate(args);
      return { ...result, value: { ...result.value, score: 5 } };
    });

    await expect(judgeWorkflow(context, 'BBCA', () => {}, (event) => events.push(event)))
      .rejects.toMatchObject({ code: 'EVIDENCE_HALLUCINATION' });

    expect(steps(events).find((event) => event.status === 'failed')?.nodeId).toBe('synthesize-verdict');
    // The model never gains authority: the run fails at the gate and no verdict is
    // ever reported to the caller or the renderers.
    expect(events.some((event) => event.type === 'verdict')).toBe(false);
    expect(events.find((event) => event.type === 'session.complete')).toMatchObject({ status: 'failed' });
  });

  it('passes one byte-identical evidence zone to every debating agent', async () => {
    const context = ctx();
    const zones: string[] = [];
    const record = (zone: string) => zones.push(zone);
    const analyze = context.bull.analyze.bind(context.bull);
    vi.spyOn(context.bull, 'analyze').mockImplementation(async (args) => { record(args.evidenceZone); return analyze(args); });
    const rebuttal = context.bull.rebuttal.bind(context.bull);
    vi.spyOn(context.bull, 'rebuttal').mockImplementation(async (args) => { record(args.evidenceZone); return rebuttal(args); });
    const challenge = context.bear.challenge.bind(context.bear);
    vi.spyOn(context.bear, 'challenge').mockImplementation(async (args) => { record(args.evidenceZone); return challenge(args); });
    const evaluate = context.judge.evaluate.bind(context.judge);
    vi.spyOn(context.judge, 'evaluate').mockImplementation(async (args) => { record(args.evidenceZone); return evaluate(args); });

    await judgeWorkflow(context, 'BBCA');

    // Zone [1] is shared with the agents unchanged: Bull, Bear, rebuttal and Judge
    // all receive the exact same bytes, which keeps prompt caching valid.
    expect(zones).toHaveLength(4);
    expect(new Set(zones).size).toBe(1);
    expect(zones[0].length).toBeGreaterThan(0);
  });

  it('gives lifecycle specialist calls typed execution context and links final snapshots', async () => {
    const context = ctx();
    const session = await db.sessions.createSession({
      sessionId: 'specialist_context_session', title: 'Specialist context', provider: 'openai', model: 'mock', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({ sessionId: session.id, input: '/judge BBCA', command: 'judge' });
    const captured: Array<Record<string, unknown>> = [];
    const analyze = context.bull.analyze.bind(context.bull);
    const rebuttal = context.bull.rebuttal.bind(context.bull);
    const challenge = context.bear.challenge.bind(context.bear);
    const evaluate = context.judge.evaluate.bind(context.judge);
    vi.spyOn(context.bull, 'analyze').mockImplementation(async (args) => { captured.push(args as unknown as Record<string, unknown>); return analyze(args); });
    vi.spyOn(context.bull, 'rebuttal').mockImplementation(async (args) => { captured.push(args as unknown as Record<string, unknown>); return rebuttal(args); });
    vi.spyOn(context.bear, 'challenge').mockImplementation(async (args) => { captured.push(args as unknown as Record<string, unknown>); return challenge(args); });
    vi.spyOn(context.judge, 'evaluate').mockImplementation(async (args) => { captured.push(args as unknown as Record<string, unknown>); return evaluate(args); });

    const result = await judgeWorkflow(context, 'BBCA', () => {}, () => {}, { lifecycle: { sessionId: session.id, turnId: turn.id } });

    const specialistContexts = captured.map(call => call.context as { contextKind: string; specialist: { role: string; evidenceIds: string[] } });
    expect(specialistContexts.map(item => `${item.specialist.role}:${item.contextKind}`)).toEqual([
      'BULL:SPECIALIST', 'BEAR:SPECIALIST', 'BULL:SPECIALIST', 'JUDGE:SPECIALIST',
    ]);
    expect(new Set(specialistContexts.map(item => item.specialist.evidenceIds.join(','))).size).toBe(1);

    const snapshots = db.raw.prepare('SELECT packet_json FROM context_snapshots WHERE session_id = ? AND turn_id = ?').all(session.id, turn.id) as Array<{ packet_json: string }>;
    expect(snapshots).toHaveLength(4);
    expect(snapshots.every(row => JSON.parse(row.packet_json).contextKind === 'SPECIALIST')).toBe(true);
    const calls = db.raw.prepare('SELECT context_snapshot_id FROM model_calls WHERE run_id = ? ORDER BY created_at').all(result.run.id) as Array<{ context_snapshot_id: string | null }>;
    expect(calls).toHaveLength(4);
    expect(calls.every(call => call.context_snapshot_id)).toBe(true);
  });

  it('snapshots every typed specialist phase in the conditional round', async () => {
    const context = ctx();
    const session = await db.sessions.createSession({
      sessionId: 'specialist_conditional_session', title: 'Conditional specialist context', provider: 'openai', model: 'mock', reasoningMode: 'reasoning',
    });
    const turn = await db.sessions.createTurn({ sessionId: session.id, input: '/judge BBCA', command: 'judge' });

    const result = await judgeWorkflow(context, 'BBCA', () => {}, () => {}, {
      reasoning: true, lifecycle: { sessionId: session.id, turnId: turn.id },
    });
    const snapshots = db.raw.prepare('SELECT packet_json FROM context_snapshots WHERE session_id = ? AND turn_id = ?').all(session.id, turn.id) as Array<{ packet_json: string }>;
    const packets = snapshots.map(row => JSON.parse(row.packet_json) as { contextKind: string; specialist: { role: string; phase: string; roundNumber: number } });

    expect(result.conditionalUsed).toBe(true);
    expect(packets).toHaveLength(7);
    expect(packets.map(packet => `${packet.specialist.role}:${packet.specialist.phase}:${packet.specialist.roundNumber}`)).toEqual(expect.arrayContaining([
      'BULL:THESIS:1', 'BEAR:CHALLENGE:1', 'BULL:REBUTTAL:1', 'JUDGE:EVALUATION:1',
      'BEAR:RECHALLENGE:2', 'BULL:REBUTTAL:2', 'JUDGE:RESOLUTION:2',
    ]));
    const calls = db.raw.prepare('SELECT context_snapshot_id FROM model_calls WHERE run_id = ?').all(result.run.id) as Array<{ context_snapshot_id: string | null }>;
    expect(calls).toHaveLength(7);
    expect(calls.every(call => call.context_snapshot_id)).toBe(true);
  });

  it('settles the canonical Execution exactly once and keeps Session/Turn identity', async () => {
    const context = ctx();
    const session = await db.sessions.createSession({
      sessionId: 'conversation_parity', title: 'Parity', provider: 'openai', model: 'mock', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({ sessionId: session.id, input: '/judge BBCA', command: 'judge' });
    const settle = vi.spyOn(db.sessions, 'settleExecution');

    const artifacts = await judgeWorkflow(context, 'BBCA', () => {}, () => {}, { lifecycle: { sessionId: session.id, turnId: turn.id } });

    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0]).toBe(artifacts.run.id);
    expect(settle.mock.calls[0][1]).toBe('completed');
    expect(db.raw.prepare('SELECT session_id, turn_id, attempt, command, status FROM executions WHERE id = ?').get(artifacts.run.id)).toEqual({
      session_id: session.id, turn_id: turn.id, attempt: 1, command: 'judge', status: 'completed',
    });
  });

  it('settles a failed canonical Execution exactly once', async () => {
    const context = ctx();
    const events: AgentEvent[] = [];
    const session = await db.sessions.createSession({
      sessionId: 'conversation_parity_fail', title: 'Parity', provider: 'openai', model: 'mock', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({ sessionId: session.id, input: '/judge ZZZZ', command: 'judge' });
    const settle = vi.spyOn(db.sessions, 'settleExecution');
    vi.spyOn(context.financialData, 'getCompanyReport').mockRejectedValue(new Error('Company report unavailable'));

    await expect(judgeWorkflow(context, 'ZZZZ', () => {}, (event) => events.push(event), { lifecycle: { sessionId: session.id, turnId: turn.id } }))
      .rejects.toThrow('Company report unavailable');

    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][1]).toBe('failed');
    expect(events.filter((event) => event.type === 'session.complete')).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
  });

  it('cancels through the workflow runtime, settles the Execution as cancelled, and stops downstream work', async () => {
    const context = ctx();
    const events: AgentEvent[] = [];
    const session = await db.sessions.createSession({
      sessionId: 'conversation_parity_cancel', title: 'Parity', provider: 'openai', model: 'mock', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({ sessionId: session.id, input: '/judge BBCA', command: 'judge' });
    const controller = new AbortController();
    const analyze = context.bull.analyze.bind(context.bull);
    vi.spyOn(context.bull, 'analyze').mockImplementation(async (args) => {
      const result = await analyze(args);
      controller.abort(new DOMException('Stopped by user', 'AbortError'));
      return result;
    });

    await expect(judgeWorkflow(context, 'BBCA', () => {}, (event) => events.push(event), {
      signal: controller.signal, lifecycle: { sessionId: session.id, turnId: turn.id },
    })).rejects.toMatchObject({ code: 'ABORTED' });

    const runId = runIdOf(events);
    expect((db.raw.prepare('SELECT status FROM executions WHERE id = ?').get(runId) as { status: string }).status).toBe('cancelled');
    // Cancellation is not a generic failure: the aborted node is recorded as
    // cancelled and the dependent debate never starts.
    expect(steps(events)).toContainEqual(expect.objectContaining({ nodeId: 'round-1-bull-thesis', status: 'cancelled' }));
    expect(steps(events).some((event) => event.nodeId === 'round-1-bear-challenge')).toBe(false);
    expect(events.find((event) => event.type === 'session.complete')).toMatchObject({ status: 'stopped' });
  });

  it('binds adapters that read only the inputs their graph declares', async () => {
    const context = ctx();
    const executors = createJudgeNodeExecutors({
      ctx: context, ticker: 'BBCA', runId: 'run_probe',
      events: () => {}, progress: () => {}, decision: {}, reasoning: false, conditional: false,
    });
    const violations: string[] = [];

    for (const node of createJudgeWorkflow().nodes) {
      const declared = new Set<string>(node.dependsOn ?? []);
      // Undeclared inputs resolve to undefined, so an adapter that reads one fails
      // fast and is reported instead of silently relying on runtime luck.
      const inputs = new Proxy({}, {
        get: (_target, key) => {
          const id = String(key);
          if (!declared.has(id)) violations.push(`${node.id} reads undeclared input ${id}`);
          return undefined;
        },
        has: () => true,
      });
      try {
        await executors[node.id](inputs as Readonly<Record<string, unknown>>);
      } catch {
        // Reading `undefined` fails is expected; the contract under test is which
        // inputs each adapter reads, not whether it can complete out of order.
      }
    }

    expect(violations).toEqual([]);
  });
});
