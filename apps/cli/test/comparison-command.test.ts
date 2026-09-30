import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import type { ComparisonMatrix, ComparisonReportPayload } from '@harness/schemas';
import type { ComparisonReportArtifact } from '@harness/session-core';
import type { AgentEvent } from '../src/repl/events';
import * as renderer from '../src/repl/renderer';
import { loadConfig } from '../src/config';
import { parseInput } from '../src/repl/parser';
import { createHarnessSession } from '../src/repl/session';

const PERIOD = '2024-Q4';
const EVIDENCE_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
] as const;

function comparisonMatrix(tickers: readonly string[]): ComparisonMatrix {
  const value = new Map([['BBCA', 2.1], ['BBRI', 7.4], ['BMRI', 1.3]]);
  const source = (index: number) => ({ evidenceId: EVIDENCE_IDS[index]!, path: `quarters[0].revenueGrowthYoy`, periodLabel: PERIOD });
  const subjects = tickers.map(ticker => ({ ticker, name: `${ticker} Corp`, sector: 'Banking' }));
  const revenueCells = tickers.map((ticker, index) => ({
    ticker,
    status: 'available' as const,
    value: value.get(ticker)!,
    unit: 'percent' as const,
    source: source(index),
  }));
  const unavailableCells = tickers.map((ticker, index) => index === 0
    ? { ticker, status: 'unavailable' as const, reason: 'BASIS_UNPROVEN' as const, unit: 'percent' as const, source: source(index) }
    : { ticker, status: 'available' as const, value: index + 2, unit: 'percent' as const, source: source(index) });
  const differences = revenueCells.flatMap((left, leftIndex) => revenueCells.slice(leftIndex + 1).map((right, offset) => ({
    metric: 'revenueGrowthYoy' as const,
    leftTicker: left.ticker,
    rightTicker: right.ticker,
    value: left.value - right.value,
    unit: 'percentage_points' as const,
    left: left.source,
    right: right.source,
  })));
  const warnings = [
    { code: 'SELECTED_PERIOD_OLDER_THAN_LATEST', ticker: tickers[0]!, selectedPeriod: PERIOD, latestAvailablePeriod: '2025-Q1' },
    { code: 'BASIS_MISSING', ticker: tickers[1]!, metric: 'netIncomeGrowthYoy' },
    { code: 'BASIS_UNPROVEN', ticker: tickers[0]!, metric: 'netIncomeGrowthYoy' },
    { code: 'MISSING_SECTOR', ticker: tickers[0]! },
    { code: 'MIXED_SECTORS', tickers: [...tickers] },
    { code: 'COMPANY_REPORT_FRESHNESS_UNKNOWN', ticker: tickers[1]! },
    { code: 'COMPANY_REPORT_TIMESTAMP_MISMATCH', tickers: [tickers[0]!] },
  ] as ComparisonMatrix['warnings'];
  return {
    subjects,
    selectedPeriod: PERIOD,
    metrics: [
      { metric: 'revenueGrowthYoy', unit: 'percent', status: 'comparable', cells: revenueCells },
      { metric: 'netIncomeGrowthYoy', unit: 'percent', status: 'unavailable', cells: unavailableCells },
    ],
    differences,
    warnings,
  } as ComparisonMatrix;
}

function comparisonArtifact(tickers: readonly string[]): ComparisonReportArtifact {
  const matrix = comparisonMatrix(tickers);
  return {
    artifactId: 'artifact-comparison-golden',
    kind: 'COMPARISON_REPORT',
    schemaVersion: 1,
    sessionId: 'session-golden',
    turnId: 'turn-golden',
    executionId: 'execution-golden',
    ticker: tickers[0]!,
    payload: matrix as ComparisonReportPayload,
    createdAt: '2026-09-30T12:34:56.000Z',
  };
}

describe('explicit /compare command', () => {
  let homeDir: string;
  let db: FinharnessDatabase;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kira-compare-command-'));
    db = openDb({ homeDir });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it.each([
    { subjects: ['bbca', 'bbri'], anchor: 'BBCA' },
    { subjects: ['bbca', 'bbri', 'bmri'], anchor: 'BBCA' },
  ])('runs one Turn and one published Compare Execution for $subjects.length subjects', async ({ subjects, anchor }) => {
    const events: AgentEvent[] = [];
    const output: string[] = [];
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }), {
      write: text => output.push(text),
      events: event => events.push(event),
    });
    try {
      const input = `/compare ${subjects.join(' ')}`;
      const parsed = parseInput(input);
      expect(parsed).toEqual({ type: 'command', command: 'compare', args: subjects });
      if (parsed.type !== 'command') throw new Error('expected explicit Compare command');
      const createTurn = vi.spyOn(db.sessions, 'createTurn');
      const createExecution = vi.spyOn(db.sessions, 'createExecution');
      const completeAndPublish = vi.spyOn(db.comparisonReportPublication, 'completeAndPublish');
      const companyReport = vi.spyOn(session.context.financialData, 'getCompanyReport');
      const quarterlyFinancials = vi.spyOn(session.context.financialData, 'getQuarterlyFinancials');
      const researcher = vi.spyOn(session.context.researcher, 'research');
      const bullAnalyze = vi.spyOn(session.context.bull, 'analyze');
      const bearChallenge = vi.spyOn(session.context.bear, 'challenge');
      const judgeEvaluate = vi.spyOn(session.context.judge, 'evaluate');
      const recordModelCall = vi.spyOn(db.sessions, 'recordModelCall');

      await session.commands.get('compare')!(parsed.args, { input });

      const sessionId = session.conversation.id;
      const records = await db.sessions.getSessionArtifacts(sessionId);
      expect(createTurn).toHaveBeenCalledExactlyOnceWith({ sessionId, input, command: 'compare' });
      expect(records.turns).toHaveLength(1);
      expect(records.turns[0]).toMatchObject({ command: 'compare', status: 'completed', input });
      expect(createExecution).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        sessionId,
        turnId: records.turns[0]!.id,
        ticker: anchor,
        command: 'compare',
      }));
      expect(records.executions).toHaveLength(1);
      expect(records.executions[0]).toMatchObject({
        sessionId,
        turnId: records.turns[0]!.id,
        command: 'compare',
        ticker: anchor,
        status: 'completed',
      });
      expect(completeAndPublish).toHaveBeenCalledOnce();
      const artifacts = await db.artifacts.getByExecution(records.executions[0]!.id);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({
        kind: 'COMPARISON_REPORT',
        sessionId,
        turnId: records.turns[0]!.id,
        executionId: records.executions[0]!.id,
        ticker: anchor,
        payload: { subjects: subjects.map(ticker => expect.objectContaining({ ticker: ticker.toUpperCase() })) },
      });
      expect(companyReport.mock.calls.map(([ticker]) => ticker)).toEqual(subjects.map(ticker => ticker.toUpperCase()));
      expect(quarterlyFinancials.mock.calls.map(([ticker]) => ticker)).toEqual(subjects.map(ticker => ticker.toUpperCase()));
      expect(researcher).not.toHaveBeenCalled();
      expect(bullAnalyze).not.toHaveBeenCalled();
      expect(bearChallenge).not.toHaveBeenCalled();
      expect(judgeEvaluate).not.toHaveBeenCalled();
      expect(recordModelCall).not.toHaveBeenCalled();
      expect(records.modelCalls).toEqual([]);

      const startIndex = events.findIndex(event => event.type === 'session.start');
      const terminalEvents = events.filter(event => event.type === 'session.complete');
      const start = events[startIndex];
      expect(start).toMatchObject({
        type: 'session.start',
        runId: records.executions[0]!.id,
        executionId: records.executions[0]!.id,
        sessionId,
        turnId: records.turns[0]!.id,
        ticker: anchor,
        command: 'compare',
        subjects: subjects.map(ticker => ticker.toUpperCase()),
      });
      const runtimeEventIndexes = events.flatMap((event, index) =>
        event.type === 'workflow.step' || event.type === 'tool.start' || event.type === 'tool.complete' ? [index] : []);
      expect(runtimeEventIndexes.length).toBeGreaterThan(0);
      expect(Math.min(...runtimeEventIndexes)).toBeGreaterThan(startIndex);
      expect(events.some(event => event.type === 'workflow.step' && event.workflowId === 'compare')).toBe(true);
      const financialEvents = events.filter(event => event.type === 'tool.start' || event.type === 'tool.complete');
      expect(financialEvents.length).toBeGreaterThan(0);
      for (const event of financialEvents) {
        if (event.type === 'tool.start' || event.type === 'tool.complete') {
          expect(event.tool).toMatch(/^(company_report|quarterly_financials)$/);
          expect(event).not.toHaveProperty('ticker');
          expect(event).not.toHaveProperty('agent');
        }
      }
      expect(terminalEvents).toHaveLength(1);
      expect(events.indexOf(terminalEvents[0]!)).toBeGreaterThan(startIndex);
      expect(events.indexOf(terminalEvents[0]!)).toBeGreaterThan(Math.max(...runtimeEventIndexes));
      expect(terminalEvents[0]).toMatchObject({
        type: 'session.complete',
        runId: records.executions[0]!.id,
        executionId: records.executions[0]!.id,
        sessionId,
        turnId: records.turns[0]!.id,
        status: 'completed',
      });
      expect(db.journal.read(sessionId).some(entry => entry.payload.type === 'run.started'
        && entry.payload.id === records.executions[0]!.id
        && entry.payload.command === 'compare'
        && entry.payload.subject === anchor)).toBe(true);
      expect(output.join('')).toContain('KIRA · COMPARE');

      expect(await db.workingContext.current(sessionId)).toMatchObject({
        currentIntent: { command: 'compare' },
        activeSubjects: subjects.map(ticker => ({ ticker: ticker.toUpperCase() })),
        activeThesisRef: null,
        activeVerdictRef: null,
        activeBullCaseRef: null,
        activeBearCaseRef: null,
        activeRiskAssessmentRef: null,
        runningSummaryRef: null,
      });
      const context = await db.workingContext.current(sessionId);
      expect(context?.pinnedArtifactRefs).not.toContainEqual(expect.objectContaining({ kind: 'COMPARISON_REPORT' }));
    } finally {
      await session.close();
    }
  });

  it.each([
    { args: [], code: 'MISSING_TICKER' },
    { args: ['BBCA'], code: 'INVALID_ARG' },
    { args: ['BBCA', 'BBRI', 'BMRI', 'BBNI'], code: 'INVALID_ARG' },
    { args: ['BBCA', 'BB-RI'], code: 'INVALID_TICKER' },
    { args: ['BBCA', ' bbca '], code: 'DUPLICATE_TICKER' },
  ])('rejects invalid subjects before any Compare Execution or provider call ($args)', async ({ args, code }) => {
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }), { write: () => undefined });
    try {
      const createExecution = vi.spyOn(db.sessions, 'createExecution');
      const companyReport = vi.spyOn(session.context.financialData, 'getCompanyReport');
      const quarterlyFinancials = vi.spyOn(session.context.financialData, 'getQuarterlyFinancials');
      const completeAndPublish = vi.spyOn(db.comparisonReportPublication, 'completeAndPublish');
      const artifactsBefore = await db.sessions.getSessionArtifacts(session.conversation.id);
      await expect(session.commands.get('compare')!(args, { input: `/compare ${args.join(' ')}` })).rejects.toMatchObject({ code });
      expect(createExecution).not.toHaveBeenCalled();
      expect(companyReport).not.toHaveBeenCalled();
      expect(quarterlyFinancials).not.toHaveBeenCalled();
      expect(completeAndPublish).not.toHaveBeenCalled();
      expect((await db.sessions.getSessionArtifacts(session.conversation.id)).executions).toHaveLength(artifactsBefore.executions.length);
      expect(await db.workingContext.current(session.conversation.id)).toBeNull();
    } finally {
      await session.close();
    }
  });

  it('settles provider failure and cancellation without artifact or WorkingContext publication', async () => {
    const events: AgentEvent[] = [];
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }), {
      write: () => undefined,
      events: event => events.push(event),
    });
    try {
      vi.spyOn(session.context.financialData, 'getCompanyReport').mockRejectedValue(new Error('company source failed'));
      await expect(session.commands.get('compare')!(['BBCA', 'BBRI'], { input: '/compare BBCA BBRI' })).rejects.toThrow();
      const records = await db.sessions.getSessionArtifacts(session.conversation.id);
      expect(records.turns[0]?.status).toBe('failed');
      expect(records.executions).toHaveLength(1);
      expect(records.executions[0]?.status).toBe('failed');
      expect(await db.artifacts.getByExecution(records.executions[0]!.id)).toEqual([]);
      expect(await db.workingContext.current(session.conversation.id)).toBeNull();
      expect(events.filter(event => event.type === 'session.complete')).toHaveLength(1);
      expect(events.find(event => event.type === 'session.complete')).toMatchObject({ status: 'failed' });
    } finally {
      await session.close();
    }
  });

  it('maps a Comparison cancellation to a stopped Turn and ABORTED terminal event', async () => {
    const events: AgentEvent[] = [];
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }), {
      write: () => undefined,
      events: event => events.push(event),
    });
    try {
      const abort = new AbortController();
      abort.abort();
      await expect(session.commands.get('compare')!(['BBCA', 'BBRI'], {
        input: '/compare BBCA BBRI',
        signal: abort.signal,
      })).rejects.toMatchObject({ code: 'ABORTED' });
      const records = await db.sessions.getSessionArtifacts(session.conversation.id);
      expect(records.turns[0]?.status).toBe('stopped');
      expect(records.executions[0]?.status).toBe('cancelled');
      expect(await db.artifacts.getByExecution(records.executions[0]!.id)).toEqual([]);
      expect(await db.workingContext.current(session.conversation.id)).toBeNull();
      expect(events.filter(event => event.type === 'session.complete')).toHaveLength(1);
      expect(events.find(event => event.type === 'session.complete')).toMatchObject({
        status: 'stopped', error: { code: 'ABORTED' },
      });
    } finally {
      await session.close();
    }
  });

  it('surfaces both action and settlement causes without fabricating terminal Turn or Session state', async () => {
    const events: AgentEvent[] = [];
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }), {
      write: () => undefined,
      events: event => events.push(event),
    });
    try {
      vi.spyOn(session.context.financialData, 'getCompanyReport').mockRejectedValue(new Error('company source failed'));
      vi.spyOn(db.sessions, 'settleExecution').mockRejectedValueOnce(new Error('execution store unavailable'));
      const error = await session.commands.get('compare')!(['BBCA', 'BBRI'], { input: '/compare BBCA BBRI' }).catch(value => value);
      expect(error).toMatchObject({
        code: 'PERSISTENCE_FAILED',
        message: expect.stringContaining('company source failed'),
      });
      expect(error.message).toContain('execution store unavailable');
      const records = await db.sessions.getSessionArtifacts(session.conversation.id);
      expect(records.turns[0]?.status).toBe('running');
      expect(records.executions[0]?.status).toBe('running');
      expect(await db.artifacts.getByExecution(records.executions[0]!.id)).toEqual([]);
      expect(await db.workingContext.current(session.conversation.id)).toBeNull();
      expect(events.filter(event => event.type === 'session.complete')).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  it('uses only the published artifact and keeps Comparison out of generic conversation retrieval', async () => {
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }), { write: () => undefined });
    try {
      await session.commands.get('compare')!(['BBCA', 'BBRI'], { input: '/compare BBCA BBRI' });
      const records = await db.sessions.getSessionArtifacts(session.conversation.id);
      const artifact = (await db.artifacts.getByExecution(records.executions[0]!.id))[0] as ComparisonReportArtifact;
      const rendered = renderer.renderComparisonResult(artifact);
      expect(rendered).toBe(renderer.renderComparisonResult(artifact));
      expect(rendered.replace('No ranking or winner is reported.', '')).not.toMatch(/winner|rank(?:ed|ing)?|best company/i);
      expect(rendered).not.toContain('Evidence ID');

      const listByQuery = vi.spyOn(db.artifacts, 'listByQuery');
      await session.context.conversationContext.prepare({
        sessionId: session.conversation.id,
        turnId: 'turn-follow-up',
        message: 'Compare with BBNI',
      });
      const retrievalQuery = listByQuery.mock.calls[0]?.[0];
      expect(retrievalQuery?.allowedKinds).toEqual(['BULL_CASE', 'BEAR_CASE', 'VERDICT']);
      expect(retrievalQuery?.allowedKinds).not.toContain('COMPARISON_REPORT');
    } finally {
      await session.close();
    }
  });

  it('keeps natural-language input in the conversation path and help keeps later commands stubbed', async () => {
    expect(parseInput('compare BBCA and BBRI')).toEqual({ type: 'natural_language', text: 'compare BBCA and BBRI' });
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }), { write: () => undefined });
    try {
      await session.commands.get('help')!([]);
      const help = session.conversation.blocks.filter(block => block.kind === 'message').map(block => block.content).join('\n');
      expect(help).toContain('/compare TICKER_A TICKER_B [TICKER_C]');
      expect(help).not.toMatch(/Roadmap \(coming soon\):[\s\S]*\/compare/);
      expect(help).toContain('/challenge [CLAIM]');
      expect(help).toContain('/investigate [TOPIC]');
    } finally {
      await session.close();
    }
  });

  it('keeps the Compare adapter limited to Engine lifecycle port composition', () => {
    const source = readFileSync(new URL('../src/workflows/compareWorkflow.ts', import.meta.url), 'utf8');
    expect(source).toContain('runComparisonExecutionLifecycle');
    expect(source).not.toMatch(/ctx\.(financialData|researcher|bull|bear|judge|mainAgent)/);
    expect(source).not.toMatch(/ctx\.db\.(artifacts|comparisonReports)\./);
    expect(source).not.toMatch(/getCompanyReport|getQuarterlyFinancials|\.completeAndPublish\(|\.invoke\(/);
  });

  it('republishes ordered subjects after restart without creating another context version', async () => {
    let session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }), { write: () => undefined });
    const sessionId = session.conversation.id;
    try {
      await session.commands.get('compare')!(['BBCA', 'BBRI', 'BMRI'], { input: '/compare BBCA BBRI BMRI' });
      const before = await db.workingContext.current(sessionId);
      expect(before?.activeSubjects).toEqual([{ ticker: 'BBCA' }, { ticker: 'BBRI' }, { ticker: 'BMRI' }]);
      await session.close();

      session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }), { write: () => undefined });
      const after = await db.workingContext.current(sessionId);
      expect(session.conversation.id).toBe(sessionId);
      expect(after?.activeSubjects).toEqual([{ ticker: 'BBCA' }, { ticker: 'BBRI' }, { ticker: 'BMRI' }]);
      expect(after?.version).toBe(before?.version);
    } finally {
      await session.close();
    }
  });
});

describe('renderComparisonResult', () => {
  it('renders schema-ordered metrics, unavailable reasons, every warning and signed differences deterministically', () => {
    const artifact = comparisonArtifact(['BBCA', 'BBRI', 'BMRI']);
    const rendered = renderer.renderComparisonResult(artifact);
    expect(rendered).toBe(renderer.renderComparisonResult(artifact));
    expect(rendered.indexOf('Revenue growth YoY')).toBeLessThan(rendered.indexOf('Net income growth YoY'));
    expect(rendered).toContain('Selected quarter: 2024-Q4');
    expect(rendered).toContain('BBCA: unavailable (BASIS_UNPROVEN)');
    expect(rendered).toContain('BBRI: +7.4%');
    expect(rendered).toContain('BBCA vs BBRI: -5.3 percentage points');
    expect(rendered).toContain('COMPANY_REPORT_TIMESTAMP_MISMATCH');
    expect(rendered).toContain('MIXED_SECTORS: BBCA, BBRI, BMRI');
    for (const warning of artifact.payload.warnings) expect(rendered).toContain(warning.code);
    expect(rendered).toContain('Execution: execution-golden');
    expect(rendered).toContain('2026-09-30T12:34:56.000Z');
    expect(rendered).toContain('No ranking or winner is reported.');
    expect(rendered).not.toMatch(/\b(best|wins|ranks? first|ranked higher)\b/i);
  });

  it('renders a two-subject report with no warnings and preserves comparison order', () => {
    const artifact = comparisonArtifact(['BBRI', 'BBCA']);
    artifact.payload.warnings = [];
    const rendered = renderer.renderComparisonResult(artifact);
    expect(rendered.indexOf('BBRI')).toBeLessThan(rendered.indexOf('BBCA'));
    expect(rendered).toContain('Warnings: none');
  });
});
