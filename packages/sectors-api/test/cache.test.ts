import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCache } from '../src/cache';

describe('FileCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'finharness-cache-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips values', () => {
    const cache = new FileCache(dir, 60_000);
    cache.set('BBCA_company_report', { roe: 23.1 });
    expect(cache.get<{ roe: number }>('BBCA_company_report')).toEqual({ roe: 23.1 });
  });

  it('returns null for missing keys', () => {
    const cache = new FileCache(dir, 60_000);
    expect(cache.get('missing')).toBeNull();
  });

  it('expires entries after TTL (deterministic: backdate fetchedAt)', () => {
    const cache = new FileCache(dir, 60_000);
    cache.set('k', { a: 1 });
    expect(cache.get<{ a: number }>('k')).toEqual({ a: 1 });

    // Backdate entry 1 jam lalu → kedaluwarsa (TTL 60 menit)
    const file = join(dir, 'k.json');
    const entry = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt: string; data: unknown };
    entry.fetchedAt = new Date(Date.now() - 3_600_001).toISOString();
    writeFileSync(file, JSON.stringify(entry));
    expect(cache.get('k')).toBeNull();
  });

  it('reuses an entry for the same calendar date and refreshes on the next date', () => {
    let now = new Date('2026-09-09T23:59:00+08:00');
    const cache = new FileCache(dir, 60_000, { calendarDay: true, now: () => now });
    cache.set('BBCA_company_report', { roe: 23.1 });

    now = new Date('2026-09-09T23:59:59+08:00');
    expect(cache.get('BBCA_company_report')).toEqual({ roe: 23.1 });

    now = new Date('2026-09-10T00:00:01+08:00');
    expect(cache.get('BBCA_company_report')).toBeNull();
  });

  it('treats corrupted files as a miss', () => {
    const cache = new FileCache(dir, 60_000);
    writeFileSync(join(dir, 'k.json'), '{not valid json');
    expect(cache.get('k')).toBeNull();
  });

  it('treats an invalid fetchedAt as a miss', () => {
    const cache = new FileCache(dir, 60_000);
    writeFileSync(join(dir, 'k.json'), JSON.stringify({ fetchedAt: 'not-a-date', data: { a: 1 } }));
    expect(cache.get('k')).toBeNull();
  });

  it('sanitizes file names to stay inside the cache dir', () => {
    const cache = new FileCache(dir, 60_000);
    cache.set('../evil', { a: 1 });
    expect(cache.get('../evil')).toEqual({ a: 1 });
    expect(existsSync(join(dir, '.._evil.json'))).toBe(true);
    expect(existsSync(join(dir, '..', 'evil.json'))).toBe(false);
  });
});
