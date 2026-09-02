import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { Orm } from './client';
import { evidence } from './schema';
import { canonicalHash } from '@harness/evidence';
import type { Evidence } from '@harness/schemas';
import type { EvidenceStore } from '@harness/evidence';

interface EvidenceRow {
  id: string;
  runId: string;
  ticker: string;
  source: string;
  sourceType: string;
  contentHash: string;
  retrievedAt: string;
  validAt: string | null;
  data: string;
  provenance: string | null;
  createdAt: string;
}

function toEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    runId: row.runId,
    ticker: row.ticker,
    source: row.source,
    sourceType: row.sourceType as Evidence['sourceType'],
    contentHash: row.contentHash,
    retrievedAt: row.retrievedAt,
    validAt: row.validAt,
    data: JSON.parse(row.data) as Record<string, unknown>,
    provenance: row.provenance ? (JSON.parse(row.provenance) as Record<string, unknown>) : null,
    createdAt: row.createdAt,
  };
}

/** Implementasi SQLite dari EvidenceStore (addendum §07/§13) — satu-satunya tempat yang menyentuh Drizzle. */
export class EvidenceStoreSqlite implements EvidenceStore {
  constructor(private readonly db: Orm) {}

  async save(params: {
    runId: string;
    ticker: string;
    source: string;
    data: Record<string, unknown>;
  }): Promise<Evidence> {
    const contentHash = canonicalHash(params.data);

    const existing = await this.db
      .select()
      .from(evidence)
      .where(eq(evidence.contentHash, contentHash))
      .limit(1);
    if (existing.length > 0) {
      return toEvidence(existing[0] as EvidenceRow);
    }

    const row: EvidenceRow = {
      id: randomUUID(),
      runId: params.runId,
      ticker: params.ticker,
      source: params.source,
      sourceType: 'api',
      contentHash,
      retrievedAt: new Date().toISOString(),
      validAt: null,
      data: JSON.stringify(params.data),
      provenance: null,
      createdAt: new Date().toISOString(),
    };
    await this.db.insert(evidence).values(row);
    return toEvidence(row);
  }

  async getManyByIds(ids: string[]): Promise<Evidence[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(evidence).where(inArray(evidence.id, ids));
    return rows.map((r) => toEvidence(r as EvidenceRow));
  }

  async getByTicker(ticker: string): Promise<Evidence[]> {
    const rows = await this.db.select().from(evidence).where(eq(evidence.ticker, ticker));
    return rows.map((r) => toEvidence(r as EvidenceRow));
  }

  async getByRun(runId: string): Promise<Evidence[]> {
    const rows = await this.db.select().from(evidence).where(eq(evidence.runId, runId));
    return rows.map((r) => toEvidence(r as EvidenceRow));
  }
}
