import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { FinancialDataVerificationError } from '@harness/financial-data';
import { UserFriendlyError } from '@harness/shared';
import type { AgentEvent } from '../src/repl/events';
import * as renderer from '../src/repl/renderer';
import { loadConfig } from '../src/config';
import { parseInput } from '../src/repl/parser';
import { createHarnessSession } from '../src/repl/session';

const QUESTION = 'assess the quality and durability of recent revenue growth';

describe('manual /research command', () => {
  let homeDir: string;
  let db: FinharnessDatabase;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kira-research-command-'));
    db = openDb({ homeDir });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('creates and publishes one canonical Research Execution inside the existing Turn lifecycle', async () => {
    const events: AgentEvent[] = [];
    const output: string[] = [];
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: text => output.push(text), events: event => events.push(event) },
    );
    try {
      const researcher = vi.spyOn(session.context.researcher, 'research');
      const bullAnalyze = vi.spyOn(session.context.bull, 'analyze');
      const bullRebuttal = vi.spyOn(session.context.bull, 'rebuttal');
      const bearChallenge = vi.spyOn(session.context.bear, 'challenge');
      const judgeEvaluate = vi.spyOn(session.context.judge, 'evaluate');
      const companyReport = vi.spyOn(session.context.financialData, 'getCompanyReport');
      const quarterlyFinancials = vi.spyOn(session.context.financialData, 'getQuarterlyFinancials');
      const dailyTransaction = vi.spyOn(session.context.financialData, 'getDailyTransaction');
      const foreignFlow = vi.spyOn(session.context.financialData, 'getForeignFlow');
      const sentiment = vi.spyOn(session.context.financialData, 'getSentiment');
      const input = `/research BBCA "${QUESTION}"`;
      const parsed = parseInput(input);
      expect(parsed).toEqual({
        type: 'command',
        command: 'research',
        args: ['BBCA', QUESTION],
      });
      if (parsed.type !== 'command') throw new Error('expected a command');

      await session.commands.get(parsed.command)!(parsed.args, { input, signal: new AbortController().signal });

      const sessionId = session.conversation.id;
      const records = await db.sessions.getSessionArtifacts(sessionId);
      expect(records.turns).toHaveLength(1);
      const [turn] = records.turns;
      expect(turn).toMatchObject({ command: 'research', status: 'completed', input });
      expect(records.executions).toHaveLength(1);
      const [execution] = records.executions;
      expect(execution).toMatchObject({
        sessionId,
        turnId: turn!.id,
        command: 'research',
        ticker: 'BBCA',
        status: 'completed',
      });
      expect(records.turns).toHaveLength(1);
      expect(turn!.status).toBe('completed');
      expect(researcher).toHaveBeenCalledTimes(1);
      expect(bullAnalyze).not.toHaveBeenCalled();
      expect(bullRebuttal).not.toHaveBeenCalled();
      expect(bearChallenge).not.toHaveBeenCalled();
      expect(judgeEvaluate).not.toHaveBeenCalled();
      expect(companyReport).toHaveBeenCalledTimes(1);
      expect(quarterlyFinancials).toHaveBeenCalledTimes(1);
      expect(dailyTransaction).not.toHaveBeenCalled();
      expect(foreignFlow).not.toHaveBeenCalled();
      expect(sentiment).not.toHaveBeenCalled();

      const artifacts = await db.artifacts.getByExecution(execution!.id);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({
        kind: 'RESEARCH_REPORT',
        sessionId,
        turnId: turn!.id,
        executionId: execution!.id,
        ticker: 'BBCA',
        payload: {
          question: QUESTION,
        },
      });

      const start = events.find(event => event.type === 'session.start');
      expect(start).toMatchObject({
        type: 'session.start',
        command: 'research',
        runId: execution!.id,
        executionId: execution!.id,
        sessionId,
        turnId: turn!.id,
        ticker: 'BBCA',
      });
      expect(events.some(event => event.type === 'workflow.step' && event.workflowId === 'research')).toBe(true);
      expect(events.some(event => event.type === 'tool.start' && event.tool === 'company_report' && event.agent === 'researcher')).toBe(true);
      expect(events.some(event => event.type === 'tool.complete' && event.tool === 'quarterly_financials' && event.agent === 'researcher')).toBe(true);
      expect(events.find(event => event.type === 'session.complete')).toMatchObject({
        type: 'session.complete',
        runId: execution!.id,
        executionId: execution!.id,
        sessionId,
        turnId: turn!.id,
        status: 'completed',
      });
      expect(db.journal.read(sessionId).some(entry => entry.payload.type === 'run.started'
        && entry.payload.id === execution!.id && entry.payload.command === 'research')).toBe(true);
      expect(output.join('')).toContain(artifacts[0]!.payload.summary);

      expect(await db.workingContext.current(sessionId)).toMatchObject({
        currentIntent: { command: 'research' },
        activeSubjects: [{ ticker: 'BBCA' }],
        activeThesisRef: null,
        activeVerdictRef: null,
        activeBullCaseRef: null,
        activeBearCaseRef: null,
        activeRiskAssessmentRef: null,
        runningSummaryRef: null,
      });
    } finally {
      await session.close();
    }
  });

  it.each([
    { input: '/research', code: 'MISSING_TICKER' },
    { input: '/research !! BBCA growth', code: 'INVALID_TICKER' },
    { input: '/research BBCA', code: 'MISSING_QUESTION' },
    { input: '/research BBCA "   "', code: 'MISSING_QUESTION' },
  ])('rejects invalid input before creating a Research Execution ($input)', async ({ input, code }) => {
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: () => undefined },
    );
    try {
      const createExecution = vi.spyOn(db.sessions, 'createExecution');
      const companyReport = vi.spyOn(session.context.financialData, 'getCompanyReport');
      const researcher = vi.spyOn(session.context.researcher, 'research');
      const parsed = parseInput(input);
      if (parsed.type !== 'command') throw new Error('expected a command');

      await expect(session.commands.get(parsed.command)!(parsed.args, { input }))
        .rejects.toMatchObject({ code });

      expect(createExecution).not.toHaveBeenCalled();
      expect(companyReport).not.toHaveBeenCalled();
      expect(researcher).not.toHaveBeenCalled();
      expect((await db.sessions.getSessionArtifacts(session.conversation.id)).executions).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  it('reports required-source failures as failed with no Researcher call or partial report', async () => {
    const events: AgentEvent[] = [];
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: () => undefined, events: event => events.push(event) },
    );
    try {
      vi.spyOn(session.context.financialData, 'getCompanyReport')
        .mockRejectedValue(new FinancialDataVerificationError('company_report', 'SUBJECT', 'Required company report mismatch'));
      const researcher = vi.spyOn(session.context.researcher, 'research');

      await expect(session.commands.get('research')!(['BBCA', QUESTION], { input: `/research BBCA ${QUESTION}` }))
        .rejects.toMatchObject({ code: 'FINANCIAL_DATA_VERIFICATION_FAILED' });

      const records = await db.sessions.getSessionArtifacts(session.conversation.id);
      expect(records.turns[0]?.status).toBe('failed');
      expect(records.executions).toHaveLength(1);
      expect(records.executions[0]).toMatchObject({ status: 'failed', command: 'research' });
      expect(await db.artifacts.getByExecution(records.executions[0]!.id)).toEqual([]);
      expect(await db.workingContext.current(session.conversation.id)).toBeNull();
      expect(researcher).not.toHaveBeenCalled();
      expect(events.find(event => event.type === 'session.complete')).toMatchObject({
        status: 'failed',
        executionId: records.executions[0]!.id,
      });
    } finally {
      await session.close();
    }
  });

  it('maps an already-aborted command signal to cancelled Execution, stopped Turn, and ABORTED event', async () => {
    const events: AgentEvent[] = [];
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: () => undefined, events: event => events.push(event) },
    );
    try {
      const abort = new AbortController();
      abort.abort();
      const companyReport = vi.spyOn(session.context.financialData, 'getCompanyReport');

      await expect(session.commands.get('research')!(['BBCA', QUESTION], {
        input: `/research BBCA ${QUESTION}`,
        signal: abort.signal,
      })).rejects.toMatchObject({ code: 'ABORTED' });

      const records = await db.sessions.getSessionArtifacts(session.conversation.id);
      expect(records.turns[0]?.status).toBe('stopped');
      expect(records.executions).toHaveLength(1);
      expect(records.executions[0]?.status).toBe('cancelled');
      expect(await db.artifacts.getByExecution(records.executions[0]!.id)).toEqual([]);
      expect(await db.workingContext.current(session.conversation.id)).toBeNull();
      expect(companyReport).not.toHaveBeenCalled();
      expect(events.find(event => event.type === 'session.complete')).toMatchObject({
        status: 'stopped',
        error: { code: 'ABORTED' },
      });
    } finally {
      await session.close();
    }
  });

  it('classifies a host ABORTED error as cancelled without an aborted signal', async () => {
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: () => undefined },
    );
    try {
      vi.spyOn(session.context.financialData, 'getCompanyReport')
        .mockRejectedValue(new UserFriendlyError('ABORTED', 'Host cancelled Research', 'Retry when ready.'));
      const abort = new AbortController();

      await expect(session.commands.get('research')!(['BBCA', QUESTION], {
        input: `/research BBCA ${QUESTION}`,
        signal: abort.signal,
      })).rejects.toMatchObject({ code: 'ABORTED' });

      const records = await db.sessions.getSessionArtifacts(session.conversation.id);
      expect(records.turns[0]?.status).toBe('stopped');
      expect(records.executions[0]?.status).toBe('cancelled');
      expect(await db.workingContext.current(session.conversation.id)).toBeNull();
    } finally {
      await session.close();
    }
  });

  it('surfaces both action and settlement failures as PERSISTENCE_FAILED', async () => {
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: () => undefined },
    );
    try {
      vi.spyOn(session.context.financialData, 'getCompanyReport').mockRejectedValue(new Error('required source failed'));
      const settleExecution = vi.spyOn(db.sessions, 'settleExecution')
        .mockRejectedValueOnce(new Error('execution store unavailable'));

      await expect(session.commands.get('research')!(['BBCA', QUESTION], {
        input: `/research BBCA ${QUESTION}`,
      })).rejects.toMatchObject({
        code: 'PERSISTENCE_FAILED',
        message: expect.stringContaining('execution store unavailable'),
      });

      expect(settleExecution).toHaveBeenCalledTimes(1);
      expect(settleExecution.mock.calls[0]?.[1]).toBe('failed');
      const records = await db.sessions.getSessionArtifacts(session.conversation.id);
      expect(records.turns[0]?.status).toBe('running');
      expect(records.executions[0]?.status).toBe('running');
      expect(await db.artifacts.getByExecution(records.executions[0]!.id)).toEqual([]);
      expect(await db.workingContext.current(session.conversation.id)).toBeNull();
    } finally {
      await session.close();
    }
  });

  it('renders durable Research payload deterministically with accepted source labels and no Judge verdict language', () => {
    const evidenceId = '00000000-0000-4000-8000-000000000001';
    const artifact = {
      artifactId: 'artifact-research-1',
      schemaVersion: 1,
      kind: 'RESEARCH_REPORT',
      sessionId: 'session-1',
      turnId: 'turn-1',
      executionId: 'execution-1',
      ticker: 'BBCA',
      createdAt: '2026-09-30T12:00:00.000Z',
      payload: {
        question: QUESTION,
        summary: 'Revenue grew while margins stayed stable.',
        findings: [{ statement: 'Quarterly revenue increased.', evidenceIds: [evidenceId], confidence: 'high' }],
        sourceAssessments: [{ evidenceId, quality: 'primary', rationale: 'Company filing.' }],
        gaps: ['Recent product mix detail is unavailable.'],
        coverage: [
          { source: 'company_report', status: 'available', evidenceIds: [evidenceId] },
          { source: 'news', status: 'unavailable', reason: 'PROVIDER_ERROR' },
          { source: 'sentiment', status: 'not_requested' },
        ],
      },
    } as const;
    const evidence = [{ id: evidenceId, source: 'sectors.company_report' }];

    const rendered = renderer.renderResearchResult(artifact as never, evidence as never);

    expect(rendered).toContain('KIRA');
    expect(rendered).toContain('BBCA');
    expect(rendered).toContain(QUESTION);
    expect(rendered).toContain('Revenue grew while margins stayed stable.');
    expect(rendered).toContain('Quarterly revenue increased.');
    expect(rendered).toContain('sectors.company_report');
    expect(rendered).toContain('Recent product mix detail is unavailable.');
    expect(rendered).not.toMatch(/\b(?:Score|Stance|Decision|BULL|BEAR|JUDGE)\b/i);
    expect(renderer.renderResearchResult(artifact as never, evidence as never)).toBe(rendered);
  });

  it('shows /research as implemented in help and keeps later commands registered', async () => {
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: () => undefined },
    );
    try {
      expect(session.commands.has('research')).toBe(true);
      expect(session.commands.has('compare')).toBe(true);
      expect(session.commands.has('challenge')).toBe(true);
      expect(session.commands.has('investigate')).toBe(true);
      const help = renderer.renderHelp();
      expect(help).toContain('/research TICKER <QUESTION>');
      expect(help).not.toMatch(/Roadmap \(coming soon\):[\s\S]*\/research/);
    } finally {
      await session.close();
    }
  });
});
