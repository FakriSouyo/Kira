import { createHash } from 'node:crypto';
import { canonicalJson } from '@harness/shared';

// sortKeys & canonicalJson kini hidup di @harness/shared (dipakai juga oleh
// renderEvidenceBlock, addendum §17) — di-re-export agar API lama tetap utuh.
export { sortKeys, canonicalJson } from '@harness/shared';

/**
 * Content hash = SHA-256 atas canonical JSON (addendum §13).
 * Objek dengan isi sama — apapun urutan key — menghasilkan hash identik.
 */
export function canonicalHash(data: unknown): string {
  return createHash('sha256').update(canonicalJson(data), 'utf8').digest('hex');
}
