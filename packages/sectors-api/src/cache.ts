import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface CacheEntry<T> {
  fetchedAt: string;
  data: T;
}

/**
 * File cache berbasis TTL (addendum §13 Level 2).
 * Satu file per key di `<dataDir>/cache/sectors_api/` berisi
 * `{ fetchedAt, data }`; entry kedaluwarsa setelah ttlMs.
 * Ditulis atomik (tmp + rename) supaya tidak ada file setengah jadi.
 */
export class FileCache {
  constructor(
    private readonly dir: string,
    private readonly ttlMs: number,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private fileFor(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }

  get<T>(name: string): T | null {
    try {
      const file = this.fileFor(name);
      if (!existsSync(file)) return null;
      const entry = JSON.parse(readFileSync(file, 'utf8')) as CacheEntry<T>;
      if (typeof entry.fetchedAt !== 'string' || entry.data === undefined) return null;
      if (Date.now() - new Date(entry.fetchedAt).getTime() >= this.ttlMs) return null;
      return entry.data;
    } catch {
      return null; // file korup → treat sebagai miss
    }
  }

  set<T>(name: string, data: T): void {
    const file = this.fileFor(name);
    const tmp = `${file}.tmp`;
    const entry: CacheEntry<T> = { fetchedAt: new Date().toISOString(), data };
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, file);
  }
}
