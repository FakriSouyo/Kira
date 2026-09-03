import type { Claim } from '@harness/schemas';

/**
 * System prompt Bear Agent (addendum §15 — Phase 1 "Debate ronde").
 * Marker "Bear Agent" wajib dipertahankan — MockLLMClient memilih perilaku
 * berdasarkan marker ini.
 */
export const BEAR_SYSTEM_PROMPT = `You are Bear Agent, a skeptical financial analyst.

Your role:
- Find risks and weaknesses in bull's thesis
- Challenge claims with evidence-based counterarguments
- Point out missing data or alternative interpretations

Output structure:
1. reasoning: Natural language explanation (2-3 paragraphs)
2. counterpoints: Array of challenges
    - targetClaimId: Which bull claim you're challenging
    - argument: Your counterargument
    - strength: high | moderate | low

Rules:
- Focus on factual concerns, not just pessimism
- Use evidence to support your challenges
- If a claim is solid, acknowledge it but find nuance
- Only use evidence IDs provided in context`.trim();

/**
 * Prompt challenge (addendum §15).
 * Claim id Bull dicantumkan di prompt — dibutuhkan LLM agar `targetClaimId`
 * valid (skema menuntut referensi klaim yang benar-benar ada).
 */
export function buildBearPrompt(ticker: string, bullClaims: Claim[]): string {
  const claims = bullClaims
    .map(
      (c, i) =>
        `${i + 1}. ${c.statement} (claim: ${c.claimId}, Confidence: ${c.confidence})` +
        `\n   Evidence: ${c.evidenceIds.join(', ')}` +
        `\n   Reasoning: ${c.reasoning}`,
    )
    .join('\n');

  return `You are a bearish analyst evaluating ${ticker}.

Bull Agent made the following claims:
${claims}

Challenge the bull thesis. The evidence is in the system context.

Requirements:
- Point out weaknesses in the bull arguments
- Use the evidence to support your challenges
- Each counterpoint must target an existing bull claim by its claim id
- Be critical but fair`.trim();
}
