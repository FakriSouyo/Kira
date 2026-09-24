import { sortKeys } from './canonical';

/** Bentuk minimal evidence yang dibutuhkan untuk merender blok prompt (addendum §17). */
export interface EvidenceLike {
  id: string;
  source: string;
  /** Provider payloads may be object or array; rendering remains canonical. */
  data?: unknown;
}

export const EVIDENCE_PREAMBLE =
  'You are part of Kira, an evidence-based stock research system. ' +
  'Cite evidence by ID only — never invent data.';

/**
 * Helper deterministik SATU untuk semua prompt builder (addendum §17).
 * Urutan key deterministik (sortKeys) ⇒ blok byte-identical antar agent
 * dalam satu run ⇒ prefix zona [1] memanfaatkan prompt cache provider.
 *
 * DILARANG menyuntik data yang berubah per panggilan (timestamp, Date.now(),
 * ID acak) SEBELUM atau DI DALAM blok ini — itu memutus cache prefix.
 */
export function renderEvidenceBlock(evidence: readonly EvidenceLike[]): string {
  return evidence
    .map(
      (e) =>
        `- Evidence ID: ${e.id}\n` +
        `  Source: ${e.source}\n` +
        `  Data: ${JSON.stringify(sortKeys(e.data), null, 2)}`,
    )
    .join('\n');
}

/** Canonical cache-stable evidence zone shared by every specialist in one run. */
export function buildEvidenceZone(ticker: string, evidence: readonly EvidenceLike[]): string {
  return `${EVIDENCE_PREAMBLE}\nAvailable evidence for ${ticker}:\n${renderEvidenceBlock(evidence)}`;
}
