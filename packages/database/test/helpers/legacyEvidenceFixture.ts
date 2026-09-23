import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalHash } from '@harness/evidence';

export interface LegacyEvidenceFixture {
  id: string;
  source: string;
}

/** Inserts a pre-T1 Evidence row and membership for read-compatibility tests. */
export function insertLegacyEvidenceFixture(
  db: Database.Database,
  params: { runId: string; ticker: string; source: string; data: Record<string, unknown> },
): LegacyEvidenceFixture {
  const id = randomUUID();
  const retrievedAt = '2026-09-01T00:00:00.000Z';
  const contentHash = canonicalHash(params.data);
  const transaction = db.transaction(() => {
    db.prepare(`INSERT INTO evidence
      (id, run_id, ticker, source, source_type, content_hash, retrieved_at, valid_at, data, provenance)
      VALUES (?, ?, ?, ?, 'api', ?, ?, NULL, ?, NULL)`)
      .run(id, params.runId, params.ticker, params.source, contentHash, retrievedAt, JSON.stringify(params.data));
    db.prepare('INSERT INTO run_evidence (run_id, evidence_id) VALUES (?, ?)').run(params.runId, id);
  });
  transaction();
  return { id, source: params.source };
}
