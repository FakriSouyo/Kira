import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import type { ArtifactEnvelope } from '@harness/session-core';
import type { BullCaseArtifactPayload } from '@harness/schemas';

const EVIDENCE_ID = '11111111-aaaa-4aaa-8aaa-111111111111';
const BULL_ARGUMENT = {
  messageId: 'bull_run_1',
  reasoning: 'Profitability and growth support the bullish case for the company.',
  claims: [{
    claimId: 'claim_1', statement: 'Profitability remains strong for the company.', confidence: 'strong' as const,
    reasoning: 'The observed return on equity supports this conclusion.', evidenceIds: [EVIDENCE_ID],
  }],
  evidenceIds: [EVIDENCE_ID],
};
const BULL_PAYLOAD = { thesis: BULL_ARGUMENT, rebuttal: { ...BULL_ARGUMENT, messageId: 'bull_rebuttal_run_1' } };

let db: FinharnessDatabase;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-artifact-store-'));
  db = openDb({ homeDir: dir });
});

afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

async function completedExecution(ticker = 'BBCA') {
  const session = await db.sessions.createSession({ sessionId: `session_${ticker}`, title: 'Artifact test', provider: 'openai', model: 'mock', reasoningMode: 'usual' });
  const turn = await db.sessions.createTurn({ sessionId: session.id, turnId: `turn_${ticker}`, input: `/judge ${ticker}`, command: 'judge' });
  const execution = await db.sessions.createExecution({ sessionId: session.id, turnId: turn.id, executionId: `run_${ticker}`, ticker, command: 'judge' });
  await db.sessions.settleExecution(execution.id, 'completed');
  await db.sessions.settleTurn(turn.id, 'completed');
  return { session, turn, execution };
}

function bullEnvelope(ids: { sessionId: string; turnId: string; executionId: string; ticker: string }, createdAt = '2026-09-18T00:00:00.000Z'): Extract<ArtifactEnvelope, { kind: 'BULL_CASE' }> {
  return {
    artifactId: `artifact_bull_case_${ids.executionId}`,
    kind: 'BULL_CASE', schemaVersion: 1,
    ...ids, payload: BULL_PAYLOAD as BullCaseArtifactPayload, createdAt,
  };
}

function links(value: Awaited<ReturnType<typeof completedExecution>>) {
  return { sessionId: value.session.id, turnId: value.turn.id, executionId: value.execution.id, ticker: value.execution.ticker };
}

describe('ArtifactStoreSqlite', () => {
  it('persists a typed envelope and resolves it by stable id after restart', async () => {
    const ids = await completedExecution();
    const saved = await db.artifacts.save(bullEnvelope(links(ids)));
    expect(saved).toEqual(bullEnvelope(links(ids)));
    expect(await db.artifacts.getById(saved.artifactId)).toEqual(saved);
    expect(await db.artifacts.resolve({ kind: 'BULL_CASE', artifactId: saved.artifactId })).toEqual(saved);
    expect(await db.artifacts.resolve({ kind: 'BEAR_CASE', artifactId: saved.artifactId })).toBeNull();

    db.raw.close();
    db = openDb({ homeDir: dir });
    expect(await db.artifacts.getById(saved.artifactId)).toEqual(saved);
    expect(await db.artifacts.getByExecution(ids.execution.id)).toEqual([saved]);
  });

  it('keeps one immutable row for repeated equivalent production', async () => {
    const ids = await completedExecution();
    const first = await db.artifacts.save(bullEnvelope(links(ids)));
    const second = await db.artifacts.save(bullEnvelope(links(ids), '2026-09-18T01:00:00.000Z'));
    expect(second).toEqual(first);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM artifacts').get()).toEqual({ count: 1 });
  });

  it('rejects a conflicting write for the same durable artifact identity', async () => {
    const ids = await completedExecution();
    await db.artifacts.save(bullEnvelope(links(ids)));
    await expect(db.artifacts.save({
      ...bullEnvelope(links(ids)), payload: { ...BULL_PAYLOAD, thesis: { ...BULL_ARGUMENT, reasoning: 'A conflicting immutable payload is not accepted.' } },
    })).rejects.toThrow(/conflict|immutable/i);
    expect((await db.artifacts.getByExecution(ids.execution.id))).toHaveLength(1);
  });

  it('rejects malformed payloads and artifacts without canonical completed linkage', async () => {
    const ids = await completedExecution();
    await expect(db.artifacts.save({ ...bullEnvelope(links(ids)), payload: { ...BULL_PAYLOAD, thesis: { ...BULL_ARGUMENT, claims: [] } } })).rejects.toThrow();

    const runningSession = await db.sessions.createSession({ sessionId: 'session_running', title: 'Running', provider: 'openai', model: 'mock', reasoningMode: 'usual' });
    const runningTurn = await db.sessions.createTurn({ sessionId: runningSession.id, turnId: 'turn_running', input: '/judge BBCA', command: 'judge' });
    const runningExecution = await db.sessions.createExecution({ sessionId: runningSession.id, turnId: runningTurn.id, executionId: 'run_running', ticker: 'BBCA', command: 'judge' });
    await expect(db.artifacts.save(bullEnvelope({ sessionId: runningSession.id, turnId: runningTurn.id, executionId: runningExecution.id, ticker: 'BBCA' }))).rejects.toThrow(/completed/i);
  });

  it('enforces session, turn, execution, and ticker ownership', async () => {
    const first = await completedExecution('BBCA');
    const second = await completedExecution('BBRI');
    await expect(db.artifacts.save(bullEnvelope({ ...links(first), sessionId: second.session.id }))).rejects.toThrow(/link|belong|session/i);
    await expect(db.artifacts.save(bullEnvelope({ ...links(first), turnId: second.turn.id }))).rejects.toThrow(/link|belong|turn/i);
    await expect(db.artifacts.save(bullEnvelope({ ...links(first), executionId: second.execution.id }))).rejects.toThrow(/link|belong|execution|ticker/i);
    await expect(db.artifacts.save(bullEnvelope({ ...links(first), ticker: 'BBRI' }))).rejects.toThrow(/ticker/i);
  });

  it('publishes a batch atomically and lists all execution artifacts', async () => {
    const ids = await completedExecution();
    const bear: ArtifactEnvelope = {
      ...bullEnvelope(links(ids)), artifactId: `artifact_bear_case_${ids.execution.id}`, kind: 'BEAR_CASE',
      payload: {
        messageId: 'bear_run_1', reasoning: 'Valuation leaves a downside challenge for the company.',
        counterpoints: [{ targetClaimId: 'claim_1', argument: 'The claim may overlook valuation risk.', strength: 'moderate' }], evidenceIds: [EVIDENCE_ID],
      },
    };
    const saved = await db.artifacts.saveMany([bullEnvelope(links(ids)), bear]);
    expect(saved.map(artifact => artifact.kind)).toEqual(['BULL_CASE', 'BEAR_CASE']);
    expect(await db.artifacts.getByExecution(ids.execution.id)).toEqual(saved);
  });

  it('rolls back the whole batch when any artifact fails validation or linkage', async () => {
    const ids = await completedExecution();
    const valid = bullEnvelope(links(ids));
    const invalid = { ...valid, artifactId: 'artifact_invalid_execution', executionId: 'run_missing' };

    await expect(db.artifacts.saveMany([valid, invalid])).rejects.toThrow(/not found/i);
    expect(await db.artifacts.getByExecution(ids.execution.id)).toEqual([]);
  });
});
