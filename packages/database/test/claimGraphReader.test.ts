import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaimPolicy,
  CounterpointPolicy,
  buildClaimGraph,
} from '@harness/execution';
import type { BearProposalOutput } from '@harness/schemas';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { insertLegacyEvidenceFixture } from './helpers/legacyEvidenceFixture';

let db: FinharnessDatabase;
let dir: string;
let runId: string;
let evidenceId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-claim-graph-'));
  db = openDb({ homeDir: dir });
  runId = (await db.execution.createRun({ ticker: 'BBCA', command: 'judge' })).id;
  evidenceId = insertLegacyEvidenceFixture(db.raw, {
    runId,
    ticker: 'BBCA',
    source: 'sectors.company_report',
    data: { roe: 23.1 },
  }).id;
});

afterEach(() => { db.raw.close(); rmSync(dir, { recursive: true, force: true }); });

async function saveClaim(claimId: string): Promise<void> {
  const [claim] = await new ClaimPolicy(db.evidence).ground({
    executionId: runId,
    allowedEvidenceIds: [evidenceId],
    seenEvidenceIds: [evidenceId],
    response: {
      reasoning: 'The company report supplies context for this durable Claim.',
      evidenceIds: [evidenceId],
      claims: [{
        claimId,
        statement: `The business outlook remains resilient for ${claimId}.`,
        confidence: 'moderate',
        reasoning: 'The report provides context without a numeric assertion.',
        evidenceIds: [evidenceId],
        evidenceLinks: [{ evidenceId, relation: 'supports', rationale: 'The report supplies relevant company context.' }],
      }],
    },
  });
  await db.claims.save({ runId, messageId: `bull-${claimId}`, claim: claim! });
}

function proposal(targetClaimIds: readonly string[]): BearProposalOutput {
  return {
    reasoning: 'The reported business outlook still leaves a durability question unresolved.',
    evidenceIds: [evidenceId],
    counterpoints: targetClaimIds.map(targetClaimId => ({
      targetClaimId,
      argument: `The available report qualifies ${targetClaimId} without establishing persistence.`,
      strength: 'moderate',
      evidenceIds: [evidenceId],
      evidenceLinks: [{ evidenceId, relation: 'qualifies', rationale: 'The report qualifies the durability of this point.' }],
    })),
  };
}

async function saveCounterpoints(
  targetClaimIds: readonly string[],
  sourceNodeId: 'round-1-bear-challenge' | 'conditional-bear-rechallenge' = 'round-1-bear-challenge',
): Promise<void> {
  const points = await new CounterpointPolicy(db.evidence).ground({
    executionId: runId,
    sourceNodeId,
    response: proposal(targetClaimIds),
    allowedEvidenceIds: [evidenceId],
    seenEvidenceIds: [evidenceId],
    allowedTargetClaimIds: targetClaimIds,
  });
  for (const point of points) await db.counterpoints.save({ runId, messageId: `bear-${sourceNodeId}`, counterpoint: point });
}

describe('ClaimGraphReaderSqlite', () => {
  it('round-trips current canonical Claim and Counterpoint state and exposes the same ExecutionArtifacts graph', async () => {
    await saveClaim('claim-1');
    await saveClaim('claim-2');
    await saveCounterpoints(['claim-1', 'claim-1']);
    await saveCounterpoints(['claim-2'], 'conditional-bear-rechallenge');

    const graph = await db.claimGraph.getByExecution(runId);
    expect(graph).toEqual(buildClaimGraph({
      executionId: runId,
      claims: await db.claims.getByRun(runId),
      counterpoints: await db.counterpoints.getByRun(runId),
    }));
    expect(graph.nodes).toHaveLength(5);
    expect(graph.edges).toEqual([
      {
        relation: 'targets',
        from: { kind: 'counterpoint', executionId: runId, counterpointId: 'counterpoint:conditional-bear-rechallenge:1' },
        to: { kind: 'claim', executionId: runId, claimId: 'claim-2' },
      },
      {
        relation: 'targets',
        from: { kind: 'counterpoint', executionId: runId, counterpointId: 'counterpoint:round-1-bear-challenge:1' },
        to: { kind: 'claim', executionId: runId, claimId: 'claim-1' },
      },
      {
        relation: 'targets',
        from: { kind: 'counterpoint', executionId: runId, counterpointId: 'counterpoint:round-1-bear-challenge:2' },
        to: { kind: 'claim', executionId: runId, claimId: 'claim-1' },
      },
    ]);
    expect(await db.claimGraph.getByExecution(runId)).toEqual(graph);
    expect((await db.execution.getExecutionWithArtifacts(runId)).claimGraph).toEqual(graph);
  });

  it('uses durable targetClaimId as the relationship authority', async () => {
    await saveClaim('claim-1');
    await saveClaim('claim-2');
    await saveCounterpoints(['claim-1']);
    db.raw.prepare('UPDATE counterpoints SET target_claim_id = ? WHERE run_id = ?').run('claim-2', runId);

    const graph = await db.claimGraph.getByExecution(runId);
    expect(graph.edges[0]?.to).toEqual({ kind: 'claim', executionId: runId, claimId: 'claim-2' });
  });

  it('keeps historical Claim rows as graph nodes without adding grounding metadata', async () => {
    db.raw.prepare(`INSERT INTO claims
      (id, run_id, message_id, claim_id, statement, confidence, reasoning, evidence_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), runId, 'legacy-bull', 'claim-pre-t2', 'A historical claim remains part of the debate.',
        'weak', null, JSON.stringify([evidenceId]));

    const stored = (await db.claims.getByRun(runId))[0]!;
    const graph = await db.claimGraph.getByExecution(runId);
    expect(stored.policyId).toBeUndefined();
    expect(stored.evidenceLinks).toBeUndefined();
    expect(graph.nodes).toEqual([{ kind: 'claim', executionId: runId, claimId: 'claim-pre-t2' }]);
    expect(graph.edges).toEqual([]);
  });

  it('returns no Counterpoint nodes or edges when the Execution has none', async () => {
    const graph = await db.claimGraph.getByExecution(runId);

    expect(graph).toEqual({ executionId: runId, nodes: [], edges: [] });
  });

  it('returns NOT_FOUND for an unknown Execution', async () => {
    await expect(db.claimGraph.getByExecution('missing-execution'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('fails closed when durable targetClaimId no longer resolves in the Execution', async () => {
    await saveClaim('claim-1');
    await saveCounterpoints(['claim-1']);
    db.raw.prepare('UPDATE counterpoints SET target_claim_id = ? WHERE run_id = ?').run('deleted-claim', runId);

    await expect(db.claimGraph.getByExecution(runId)).rejects.toThrow(/targets missing Claim/);
    await expect(db.execution.getExecutionWithArtifacts(runId)).rejects.toThrow(/targets missing Claim/);
  });
});
