import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { canonicalJson } from '@harness/shared';
import type { Orm } from './client';
import { claims } from './schema';
import type { ClaimStore, StoredClaim } from '@harness/execution';
import type { Claim } from '@harness/schemas';

interface ClaimRow {
  id: string;
  runId: string;
  messageId: string | null;
  claimId: string;
  statement: string;
  confidence: string;
  reasoning: string | null;
  evidenceIds: string;
  createdAt: string;
}

function toStored(row: ClaimRow): StoredClaim {
  return {
    id: row.id,
    runId: row.runId,
    messageId: row.messageId,
    claimId: row.claimId,
    statement: row.statement,
    confidence: row.confidence as StoredClaim['confidence'],
    reasoning: row.reasoning,
    evidenceIds: JSON.parse(row.evidenceIds) as string[],
    createdAt: row.createdAt,
  };
}

/** Implementasi SQLite dari ClaimStore (addendum §11/Task 14). */
export class ClaimStoreSqlite implements ClaimStore {
  constructor(private readonly db: Orm) {}

  async save(params: { runId: string; messageId: string; claim: Claim }): Promise<StoredClaim> {
    const row: ClaimRow = {
      id: randomUUID(),
      runId: params.runId,
      messageId: params.messageId,
      claimId: params.claim.claimId,
      statement: params.claim.statement,
      confidence: params.claim.confidence,
      reasoning: params.claim.reasoning,
      evidenceIds: JSON.stringify(params.claim.evidenceIds),
      createdAt: new Date().toISOString(),
    };
    await this.db.insert(claims).values(row).onConflictDoNothing({ target: [claims.runId, claims.claimId] });
    const stored = await this.db.select().from(claims).where(and(eq(claims.runId, params.runId), eq(claims.claimId, params.claim.claimId))).limit(1);
    if (!stored[0]) throw new Error(`Claim ${params.claim.claimId} was not persisted`);
    const result = toStored(stored[0] as ClaimRow);
    const expected = {
      runId: params.runId,
      messageId: params.messageId,
      claimId: params.claim.claimId,
      statement: params.claim.statement,
      confidence: params.claim.confidence,
      reasoning: params.claim.reasoning,
      evidenceIds: params.claim.evidenceIds,
    };
    const actual = {
      runId: result.runId,
      messageId: result.messageId,
      claimId: result.claimId,
      statement: result.statement,
      confidence: result.confidence,
      reasoning: result.reasoning,
      evidenceIds: result.evidenceIds,
    };
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error(`Claim ${params.runId}/${params.claim.claimId} immutable identity conflict`);
    }
    return result;
  }

  async getByRun(runId: string): Promise<StoredClaim[]> {
    const rows = await this.db
      .select()
      .from(claims)
      .where(eq(claims.runId, runId))
      .orderBy(asc(claims.claimId));
    return rows.map((r) => toStored(r as ClaimRow));
  }
}
