import type { ToolRuntimeEvent } from '@harness/tool-runtime';
import type { AgentEvent, AgentToolName } from '../repl/events';

const agentToolByRuntimeId: Record<string, AgentToolName> = {
  'financial.company-report': 'company_report',
  'financial.quarterly-financials': 'quarterly_financials',
  'financial.daily-transaction': 'daily_transaction',
  'financial.foreign-flow': 'foreign_flow',
  'financial.news': 'news',
  'financial.filings': 'filings',
  'financial.sentiment': 'sentiment',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function projectFinancialToolEvent(
  event: ToolRuntimeEvent,
  params: { readonly ticker: string; readonly emit: (event: AgentEvent) => void },
): void {
  const tool = agentToolByRuntimeId[event.toolId];
  if (!tool) return;

  if (event.type === 'tool.started') {
    params.emit({ type: 'tool.start', tool, ticker: params.ticker, agent: 'researcher' });
    return;
  }

  params.emit({
    type: 'tool.complete',
    tool,
    agent: 'researcher',
    durationMs: event.durationMs,
    ...(event.type === 'tool.failed'
      ? { error: errorMessage(event.error) }
      : event.type === 'tool.cancelled' ? { error: 'Aborted' } : {}),
  });
}
