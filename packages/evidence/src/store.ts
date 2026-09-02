import type { Evidence } from '@harness/schemas';

/**
 * Interface murni — tanpa tipe Drizzle (addendum §10, locked).
 * Implementasi konkret (EvidenceStoreSqlite) hidup di packages/database.
 */
export interface EvidenceStore {
  /** Simpan evidence dengan dedup content-hash; return row yang ada bila sudah ada. */
  save(params: {
    runId: string;
    ticker: string;
    source: string;
    data: Record<string, unknown>;
  }): Promise<Evidence>;

  /** API utama agent: ambil evidence penuh berdasarkan IDs. */
  getManyByIds(ids: string[]): Promise<Evidence[]>;

  /** Query untuk debugging/UI. */
  getByTicker(ticker: string): Promise<Evidence[]>;

  /** Query untuk audit trail. */
  getByRun(runId: string): Promise<Evidence[]>;
}
