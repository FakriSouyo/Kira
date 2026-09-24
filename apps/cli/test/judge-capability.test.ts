import { describe, expect, it, vi } from 'vitest';
import { financialToolIds, JUDGE_CAPABILITY_PRINCIPALS } from '@harness/engine';
import type { AgentEvent } from '../src/repl/events';
import type { HarnessContext } from '../src/context';
import { createJudgeNodeExecutors } from '../src/workflows/judgeNodes';

describe('Judge capability composition', () => {
  it('uses explicit Judge principals and preserves financial tool event projection', async () => {
    const invoke = vi.fn(async (
      _principal: { id: string },
      capabilityId: string,
      _input: unknown,
      options?: { onEvent?: (event: unknown) => unknown },
    ) => {
      await options?.onEvent?.({ type: 'tool.started', toolId: capabilityId });
      await options?.onEvent?.({ type: 'tool.completed', toolId: capabilityId, durationMs: 1 });
      return {
        value: { data: {}, metadata: {} },
        metadata: { toolId: capabilityId, durationMs: 1 },
      };
    });
    const events: AgentEvent[] = [];
    const context = {
      capabilityGateway: { invoke },
      researchers: { market: true, news: true },
    } as unknown as HarnessContext;

    const executors = createJudgeNodeExecutors({
      ctx: context,
      ticker: 'BBCA',
      runId: 'run_judge_capability',
      events: (event) => events.push(event),
      progress: () => {},
      decision: {},
      reasoning: false,
      conditional: false,
    });
    const signal = new AbortController().signal;

    await executors['identify-company']({}, signal);
    await executors['fetch-financials']({}, signal);
    await executors['fetch-market-data']({}, signal);
    await executors['fetch-news']({}, signal);

    expect(invoke.mock.calls.map(([principal, capabilityId, input]) => [
      (principal as { id: string }).id,
      capabilityId,
      input,
    ])).toEqual([
      ['workflow.judge.identify-company', financialToolIds.companyReport, { ticker: 'BBCA' }],
      ['workflow.judge.fetch-financials', financialToolIds.quarterlyFinancials, { ticker: 'BBCA' }],
      ['workflow.judge.fetch-market-data', financialToolIds.dailyTransaction, { ticker: 'BBCA' }],
      ['workflow.judge.fetch-market-data', financialToolIds.foreignFlow, { ticker: 'BBCA' }],
      ['workflow.judge.fetch-news', financialToolIds.news, { ticker: 'BBCA' }],
      ['workflow.judge.fetch-news', financialToolIds.filings, { ticker: 'BBCA' }],
      ['workflow.judge.fetch-news', financialToolIds.sentiment, { ticker: 'BBCA' }],
    ]);
    expect(invoke.mock.calls[0]?.[0]).toBe(JUDGE_CAPABILITY_PRINCIPALS.identifyCompany);
    expect(invoke.mock.calls[1]?.[0]).toBe(JUDGE_CAPABILITY_PRINCIPALS.fetchFinancials);
    expect(invoke.mock.calls[2]?.[0]).toBe(JUDGE_CAPABILITY_PRINCIPALS.fetchMarketData);
    expect(invoke.mock.calls[4]?.[0]).toBe(JUDGE_CAPABILITY_PRINCIPALS.fetchNews);
    expect(events.filter((event) => event.type === 'tool.start')).toHaveLength(7);
    expect(events.filter((event) => event.type === 'tool.complete')).toHaveLength(7);
    expect(events.filter((event) => event.type === 'tool.start').map((event) => event.tool)).toEqual([
      'company_report',
      'quarterly_financials',
      'daily_transaction',
      'foreign_flow',
      'news',
      'filings',
      'sentiment',
    ]);
  });
});
