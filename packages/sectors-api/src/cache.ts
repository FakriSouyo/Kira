import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CacheEntryMeta {
  /** Tanggal data yang sebenarnya (mis. latest_close_date). Bukan waktu fetch. */
  dataAsOf?: string;
  /** Periode data (mis. "2026-Q2" untuk financials kuartalan). */
  period?: string;
  /** Normalized provider requirement identity; never a workflow/run identity. */
  cacheIdentity?: string;
  schemaVersion?: number;
  adapterVersion?: string;
  source?: 'sectors-api' | 'mock';
  /** Deterministic lineage for values derived from other provider operations. */
  derivedFrom?: string[];
}

export interface CacheEntry<T> {
  fetchedAt: string;
  data: T;
  meta?: CacheEntryMeta;
}

/**
 * File cache berbasis TTL + freshness data (addendum §13 Level 2 + Audit doc F2/F3).
 * Satu file per key di `<dataDir>/cache/sectors_api/` berisi
 * `{ fetchedAt, meta?, data }`; entry kedaluwarsa setelah ttlMs.
 * `meta.dataAsOf`/`meta.period` membedakan "kapan di-fetch" (fetchedAt) dari
 * "data untuk tanggal/periode apa" (dataAsOf/period); policy per-operation
 * menentukan apakah entry tersebut masih dapat dipakai ulang.
 * Ditulis atomik (tmp + rename) supaya tidak ada file setengah jadi.
 */
export class FileCache {
  constructor(
    private readonly dir: string,
    private readonly ttlMs: number,
    private readonly options: { calendarDay?: boolean; now?: () => Date } = {},
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private fileFor(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }

  /** Ambil entry penuh (data + meta + fetchedAt) tanpa kedaluwarsa TTL/datetime. */
  getEntry<T>(name: string): CacheEntry<T> | null {
    try {
      const file = this.fileFor(name);
      if (!existsSync(file)) return null;
      const entry = JSON.parse(readFileSync(file, 'utf8')) as CacheEntry<T>;
      if (typeof entry.fetchedAt !== 'string' || entry.data === undefined) return null;
      if (!Number.isFinite(new Date(entry.fetchedAt).getTime())) return null;
      return entry;
    } catch {
      return null; // file korup → treat sebagai miss
    }
  }

  /** Valid TTL/datetime: entry tidak kedaluwarsa berdasarkan waktu fetch (bukan data). */
  withinFetchWindow(entry: CacheEntry<unknown>): boolean {
    const now = this.options.now?.() ?? new Date();
    const fetched = new Date(entry.fetchedAt);
    if (!Number.isFinite(fetched.getTime())) return false;
    if (this.options.calendarDay) {
      const day = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      if (day(now) !== day(fetched)) return false;
    } else if (now.getTime() - fetched.getTime() >= this.ttlMs) {
      return false;
    }
    return true;
  }

  get<T>(name: string): T | null {
    const entry = this.getEntry<T>(name);
    if (!entry || !this.withinFetchWindow(entry)) return null;
    return entry.data;
  }

  set<T>(name: string, data: T, meta?: CacheEntryMeta): CacheEntry<T> {
    const file = this.fileFor(name);
    const tmp = `${file}.tmp`;
    const entry: CacheEntry<T> = { fetchedAt: (this.options.now?.() ?? new Date()).toISOString(), data, meta };
    try {
      writeFileSync(tmp, JSON.stringify(entry));
      try {
        renameSync(tmp, file);
      } catch {
        // Windows: target mungkin sedang di-read → fallback tulis langsung
        try { writeFileSync(file, JSON.stringify(entry)); } catch {}
        try { unlinkSync(tmp); } catch {}
      }
    } catch {
      // cache write is best-effort; jangan ganggu flow utama
    }
    return entry;
  }
}
