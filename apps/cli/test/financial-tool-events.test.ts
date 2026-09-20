import { describe, expect, it } from 'vitest';
import type { ToolRuntimeEvent } from '@harness/tool-runtime';
import { projectFinancialToolEvent } from '../src/tools/financialToolEvents';

describe('financial tool event projection', () => {
  it('maps generic runtime lifecycle to the existing AgentEvent shape', () => {
    const events: unknown[] = [];
    const emit = (event: unknown) => events.push(event);

    projectFinancialToolEvent({ type: 'tool.started', toolId: 'financial.company-report' }, {
      ticker: 'BBCA', emit,
    });
    projectFinancialToolEvent({ type: 'tool.completed', toolId: 'financial.company-report', durationMs: 12 }, {
      ticker: 'BBCA', emit,
    });

    expect(events).toEqual([
      { type: 'tool.start', tool: 'company_report', ticker: 'BBCA', agent: 'researcher' },
      { type: 'tool.complete', tool: 'company_report', durationMs: 12, agent: 'researcher' },
    ]);
  });

  it('projects failures and cancellation without adding a second terminal event', () => {
    const events: unknown[] = [];
    const emit = (event: unknown) => events.push(event);
    const failure: ToolRuntimeEvent = {
      type: 'tool.failed', toolId: 'financial.news', durationMs: 5, error: new Error('News unavailable'),
    };

    projectFinancialToolEvent(failure, { ticker: 'BBCA', emit });
    projectFinancialToolEvent({ type: 'tool.cancelled', toolId: 'financial.sentiment', durationMs: 6 }, {
      ticker: 'BBCA', emit,
    });

    expect(events).toEqual([
      { type: 'tool.complete', tool: 'news', durationMs: 5, agent: 'researcher', error: 'News unavailable' },
      { type: 'tool.complete', tool: 'sentiment', durationMs: 6, agent: 'researcher', error: 'Aborted' },
    ]);
  });
});
