import { renderEvidenceBlock, type EvidenceLike } from '@harness/shared';

/**
 * Preamble zona [1] (addendum §17 · Token & Cache Strategy).
 * Blok hasil buildEvidenceZone() HARUS byte-identical untuk semua panggilan
 * agent yang mengonsumsi evidence yang sama dalam satu run — itulah yang
 * membuat prefix masuk prompt cache provider (OpenAI otomatis, Anthropic
 * via breakpoint cache_control yang dipasang LLMClient).
 */
export const EVIDENCE_PREAMBLE =
  'You are part of the Financial Agent Harness, an evidence-based stock research system. ' +
  'Cite evidence by ID only — never invent data.';

export function buildEvidenceZone(ticker: string, evidence: readonly EvidenceLike[]): string {
  return `${EVIDENCE_PREAMBLE}\nAvailable evidence for ${ticker}:\n${renderEvidenceBlock(evidence)}`;
}
