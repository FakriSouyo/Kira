import { describe, expect, it } from 'vitest';
import {
  aggregateModelUsage,
  calculateModelCost,
  transitionTurn,
  type ModelUsage,
  type ResearchTurn,
} from '../src/index.js';

const runningTurn: ResearchTurn = {
  id: 'turn-1',
  sessionId: 'session-1',
  runId: 'run-1',
  input: '/judge BBCA',
  command: 'judge',
  status: 'running',
  startedAt: '2026-09-08T01:00:00.000Z',
  completedAt: null,
};

describe('turn lifecycle', () => {
  it.each(['completed', 'failed', 'stopped'] as const)('settles a running turn as %s', (status) => {
    expect(transitionTurn(runningTurn, status, '2026-09-08T01:00:05.000Z')).toEqual({
      ...runningTurn,
      status,
      completedAt: '2026-09-08T01:00:05.000Z',
    });
  });

  it('rejects reopening a terminal turn', () => {
    const completed = transitionTurn(runningTurn, 'completed', '2026-09-08T01:00:05.000Z');

    expect(() => transitionTurn(completed, 'running', '2026-09-08T01:00:06.000Z')).toThrowError(
      'Turn turn-1 cannot transition from completed to running',
    );
  });
});

describe('model usage aggregation', () => {
  it('calculates cost from explicit per-million pricing and cached input', () => {
    expect(calculateModelCost(
      { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, totalTokens: 1500 },
      { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5, currency: 'USD' },
    )).toEqual({ cost: 0.0057, currency: 'USD' });
  });

  it('keeps cost unavailable when usage or model pricing is incomplete', () => {
    expect(calculateModelCost(
      { inputTokens: 1000, outputTokens: null, cachedInputTokens: null, totalTokens: null },
      { inputPerMillion: 2, outputPerMillion: 8, currency: 'USD' },
    )).toEqual({ cost: null, currency: null });
    expect(calculateModelCost(
      { inputTokens: 1000, outputTokens: 500, cachedInputTokens: null, totalTokens: 1500 },
      null,
    )).toEqual({ cost: null, currency: null });
  });

  it('sums fully reported calls including cached tokens and cost', () => {
    const calls: ModelUsage[] = [
      { inputTokens: 100, outputTokens: 40, cachedInputTokens: 20, totalTokens: 140, cost: 0.002, currency: 'USD' },
      { inputTokens: 50, outputTokens: 10, cachedInputTokens: 0, totalTokens: 60, cost: 0.001, currency: 'USD' },
    ];

    expect(aggregateModelUsage(calls)).toEqual({
      inputTokens: 150,
      outputTokens: 50,
      cachedInputTokens: 20,
      totalTokens: 200,
      cost: 0.003,
      currency: 'USD',
    });
  });

  it('returns unavailable totals instead of misleading partial totals', () => {
    const calls: ModelUsage[] = [
      { inputTokens: 100, outputTokens: 40, cachedInputTokens: null, totalTokens: 140, cost: 0.002, currency: 'USD' },
      { inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, cost: null, currency: null },
    ];

    expect(aggregateModelUsage(calls)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      totalTokens: null,
      cost: null,
      currency: null,
    });
  });
});
