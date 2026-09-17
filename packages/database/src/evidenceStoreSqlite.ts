import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { Orm } from './client';
import { evidence, runEvidence } from './schema';
import { canonicalHash } from '@harness/evidence';
import type { Evidence } from '@harness/schemas';
import type { EvidenceStore } from '@harness/evidence';

export interface EvidenceRow {
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

/** Pemetaan baris evidence → objek canonical — dipakai EvidenceStore AND session helper (getExecutionWithArtifacts). */
export function toEvidence(row: EvidenceRow): Evidence {
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
      .limit(10);
    const scoped = existing.find((r) => r.ticker === params.ticker && r.source === params.source);
    if (scoped) {
      await this.db.insert(runEvidence).values({ runId: params.runId, evidenceId: scoped.id }).onConflictDoNothing();
      return toEvidence(scoped as EvidenceRow);
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
    this.db.transaction((tx) => {
      tx.insert(evidence).values(row).run();
      tx.insert(runEvidence).values({ runId: params.runId, evidenceId: row.id }).run();
    });
    return toEvidence(row);
  }

  async getManyByIds(ids: string[]): Promise<Evidence[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(evidence).where(inArray(evidence.id, ids));
    const byId = new Map(rows.map((r) => [r.id, toEvidence(r as EvidenceRow)]));
    return ids.flatMap((id) => { const row = byId.get(id); return row ? [row] : []; });
  }

  async getByTicker(ticker: string): Promise<Evidence[]> {
    const rows = await this.db.select().from(evidence).where(eq(evidence.ticker, ticker));
    return rows.map((r) => toEvidence(r as EvidenceRow));
  }

  async getByRun(runId: string): Promise<Evidence[]> {
    const rows = await this.db.select({ evidence }).from(runEvidence)
      .innerJoin(evidence, eq(runEvidence.evidenceId, evidence.id)).where(eq(runEvidence.runId, runId));
    return rows.map((r) => toEvidence(r.evidence as EvidenceRow));
  }
}
