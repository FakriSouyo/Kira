import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { verifyFinancialObservation } from '@harness/financial-data';
import { createFinancialEvidenceCandidate, decideEvidenceCandidate } from '@harness/evidence';
import { openDb } from '../src/client';
import { insertLegacyEvidenceFixture } from './helpers/legacyEvidenceFixture';

let dir: string;
let db: ReturnType<typeof openDb>;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'finharness-t-evidence-')); db = openDb({ homeDir: dir }); });
afterEach(() => { db.raw.close(); rmSync(dir, { recursive: true, force: true }); });

it('does not expose a policy-less Evidence writer', () => {
  expect('save' in db.evidence).toBe(false);
  expect('persist' in db.evidence).toBe(false);
});

it('deduplicates content while keeping acceptance metadata and ownership per execution', async () => {
  const a = await db.execution.createRun({ ticker: 'BBRI', command: 'judge' });
  const b = await db.execution.createRun({ ticker: 'BBRI', command: 'judge' });
  const base = { ticker: 'BBRI', source: 'sectors.company_report', data: { roe: 23.1 } };
  const makeReceipt = (runId: string, origin: 'PROVIDER' | 'CACHE', acceptedAt: string) => {
    const data = { ticker: 'BBRI', asOf: '2026-09-18', financials: { roe: 23.1 }, valuation: { pe: 10 } };
    const observation = verifyFinancialObservation('company_report', { data, metadata: {
      providerId: 'sectors', source: base.source, origin, fetchedAt: '2026-09-19T00:00:00.000Z',
      dataAsOf: '2026-09-18T00:00:00.000Z', requestedAsOf: null, period: null, derivedFrom: [],
    } }, base.ticker);
    return decideEvidenceCandidate(createFinancialEvidenceCandidate({ executionId: runId, ticker: base.ticker, observation }), acceptedAt);
  };
  const firstReceipt = makeReceipt(a.id, 'PROVIDER', '2026-09-20T00:00:00.000Z');
  const secondReceipt = makeReceipt(b.id, 'CACHE', '2026-09-21T01:00:00.000Z');
  if (!firstReceipt.accepted || !secondReceipt.accepted) throw new Error('test candidate should be accepted');
  const first = await db.evidence.accept({ ...base, runId: a.id, data: firstReceipt.data, acceptance: firstReceipt });
  const second = await db.evidence.accept({ ...base, runId: b.id, data: secondReceipt.data, acceptance: secondReceipt });
  expect(second.id).toBe(first.id);
  expect(second.runId).toBe(b.id);
  expect(second.sourceType).toBe('cached');
  expect(second.acceptance?.acceptedAt).toBe('2026-09-21T01:00:00.000Z');
  expect((await db.evidence.getManyByIdsForRun(b.id, [first.id]))[0]).toMatchObject({
    runId: b.id, sourceType: 'cached', retrievedAt: '2026-09-19T00:00:00.000Z', validAt: null,
    acceptance: { policyId: 'evidence-policy-v1', policyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), sourceOrigin: 'CACHE', acceptedAt: '2026-09-21T01:00:00.000Z', provenance: {
      metadata: { providerId: 'sectors', origin: 'CACHE', dataAsOf: '2026-09-18T00:00:00.000Z' },
      verification: { schema: 'PASS', subject: 'PASS', provenance: 'PASS', temporal: 'PASS' },
    } },
  });
  expect((await db.execution.getExecutionWithArtifacts(b.id)).evidence[0]).toMatchObject({ runId: b.id, sourceType: 'cached' });
  const retryReceipt = { ...secondReceipt, acceptedAt: '2026-09-22T01:00:00.000Z', data: secondReceipt.data };
  const retry = await db.evidence.accept({ ...base, data: retryReceipt.data, runId: b.id, acceptance: retryReceipt });
  expect(retry.id).toBe(second.id);
  expect(retry.acceptance?.acceptedAt).toBe('2026-09-21T01:00:00.000Z');
  expect((await db.evidence.getManyByIdsForRun(b.id, [second.id]))[0].acceptance?.acceptedAt).toBe('2026-09-21T01:00:00.000Z');

  const conflictingReceipt = makeReceipt(b.id, 'PROVIDER', '2026-09-23T01:00:00.000Z');
  if (!conflictingReceipt.accepted) throw new Error('test candidate should be accepted');
  await expect(db.evidence.accept({ ...base, data: conflictingReceipt.data, runId: b.id, acceptance: conflictingReceipt }))
    .rejects.toThrow(/immutable acceptance conflict/);
});

it('fails closed when the stored acceptance policy fingerprint is corrupted', async () => {
  const run = await db.execution.createRun({ ticker: 'BBRI', command: 'judge' });
  const data = { ticker: 'BBRI', asOf: '2026-09-18', financials: { roe: 23.1 }, valuation: { pe: 10 } };
  const observation = verifyFinancialObservation('company_report', { data, metadata: {
    providerId: 'sectors', source: 'sectors.company_report', origin: 'MOCK', fetchedAt: null,
    dataAsOf: null, requestedAsOf: null, period: null, derivedFrom: [],
  } }, 'BBRI');
  const decision = decideEvidenceCandidate(createFinancialEvidenceCandidate({ executionId: run.id, ticker: 'BBRI', observation }), '2026-09-20T00:00:00.000Z');
  if (!decision.accepted) throw new Error('test candidate should be accepted');
  const stored = await db.evidence.accept({ runId: run.id, ticker: 'BBRI', source: decision.source, data: decision.data, acceptance: decision });
  db.raw.prepare('UPDATE run_evidence SET policy_fingerprint = ? WHERE run_id = ? AND evidence_id = ?').run('0'.repeat(64), run.id, stored.id);
  await expect(db.evidence.getManyByIdsForRun(run.id, [stored.id])).rejects.toThrow(/is corrupt/);
});

it('does not misclassify partially erased acceptance metadata as legacy', async () => {
  const run = await db.execution.createRun({ ticker: 'BBRI', command: 'judge' });
  const data = { ticker: 'BBRI', asOf: '2026-09-18', financials: { roe: 23.1 }, valuation: { pe: 10 } };
  const observation = verifyFinancialObservation('company_report', { data, metadata: {
    providerId: 'sectors', source: 'sectors.company_report', origin: 'MOCK', fetchedAt: null,
    dataAsOf: null, requestedAsOf: null, period: null, derivedFrom: [],
  } }, 'BBRI');
  const decision = decideEvidenceCandidate(createFinancialEvidenceCandidate({ executionId: run.id, ticker: 'BBRI', observation }), '2026-09-20T00:00:00.000Z');
  if (!decision.accepted) throw new Error('test candidate should be accepted');
  const stored = await db.evidence.accept({ runId: run.id, ticker: 'BBRI', source: decision.source, data: decision.data, acceptance: decision });
  db.raw.prepare('UPDATE run_evidence SET policy_id = NULL WHERE run_id = ? AND evidence_id = ?').run(run.id, stored.id);
  await expect(db.evidence.getManyByIdsForRun(run.id, [stored.id])).rejects.toThrow(/partial acceptance metadata/);
});

it('returns historical run_evidence rows with explicit legacy provenance', async () => {
  const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
  const evidence = insertLegacyEvidenceFixture(db.raw, { runId: run.id, ticker: 'BBCA', source: 'legacy.api', data: { roe: 12 } });
  const [scoped] = await db.evidence.getManyByIdsForRun(run.id, [evidence.id]);
  expect(scoped).toMatchObject({ runId: run.id, acceptance: { policyId: 'legacy-v0', candidateKind: 'legacy', legacy: true } });
});

it('does not return globally existing Evidence outside the requested Execution', async () => {
  const owner = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
  const other = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
  const evidence = insertLegacyEvidenceFixture(db.raw, { runId: owner.id, ticker: 'BBCA', source: 'legacy.api', data: { roe: 17 } });
  expect(await db.evidence.getManyByIdsForRun(other.id, [evidence.id])).toEqual([]);
});
