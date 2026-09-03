import { ClaimSchema, type Claim, type Evidence } from '@harness/schemas';
import { UserFriendlyError, ValidationError } from '@harness/shared';
import type { EvidenceStore } from '@harness/evidence';

/**
 * Validasi claim 3 lapis (addendum §16):
 *   Layer 1 — struktur (Zod)
 *   Layer 2 — evidence ada di DB
 *   Layer 3 — evidence termasuk allowed set milik run ini
 */
export class ClaimValidator {
  constructor(private readonly evidenceStore: EvidenceStore) {}

  /**
   * Baca evidence; bila *eksekusi* store gagal (DB/network), bungkus sebagai
   * `VALIDATION_UNAVAILABLE` — fail-closed (addendum §24-B.3): jangan pernah
   * lanjut tanpa proof eksistensi. (Kegagalan *data* = store sukses tapi id
   * tak ada → ditangani pemanggil sebagai ValidationError.)
   */
  private async readEvidence(ids: string[]): Promise<Evidence[]> {
    try {
      return await this.evidenceStore.getManyByIds(ids);
    } catch (cause) {
      throw new UserFriendlyError(
        'VALIDATION_UNAVAILABLE',
        `Could not execute evidence validation (storage read failed): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        `Run failed because proof of evidence existence could not be checked — integrity is fail-closed (addendum §24-B.3).`,
      );
    }
  }

  /**
   * Validasi challenge Bear (Phase 1, addendum §16/§15) — run-scoped:
   *   - setiap targetClaimId harus menunjuk klaim Bull milik run ini
   *   - evidenceIds Bear harus ada di DB dan termasuk allowed set run
   * (struktur `strength`/`argument` sudah ditegakkan Zod di BearLLMOutputSchema)
   */
  async validateChallenge(
    counterpoints: Array<{ targetClaimId: string; argument: string; strength: string }>,
    bearEvidenceIds: string[],
    allowed: { claimIds: string[]; evidenceIds: string[] },
  ): Promise<void> {
    const allowedClaims = new Set(allowed.claimIds);
    for (const cp of counterpoints) {
      if (!allowedClaims.has(cp.targetClaimId)) {
        throw new ValidationError(
          `Challenge targets unknown claim ${cp.targetClaimId}. ` +
            `Known claim ids: ${allowed.claimIds.join(', ') || '(none)'}`,
        );
      }
    }

    const uniqueIds = [...new Set(bearEvidenceIds)];
    const existing = await this.readEvidence(uniqueIds);
    const existingIds = new Set(existing.map((e) => e.id));
    const allowedEvidence = new Set(allowed.evidenceIds);
    for (const id of uniqueIds) {
      if (!existingIds.has(id)) {
        throw new ValidationError(`Evidence ${id} does not exist in database (bear challenge)`);
      }
      if (!allowedEvidence.has(id)) {
        throw new ValidationError(
          `Evidence ${id} not in allowed set for this run (bear challenge). ` +
            `Allowed: ${allowed.evidenceIds.join(', ')}`,
        );
      }
    }
  }

  async validate(claims: Claim[], allowedEvidenceIds: string[]): Promise<Claim[]> {
    // Layer 1: Structural validation (Zod)
    const parsed = ClaimSchema.array().parse(claims);

    // Layer 2: Evidence existence check (DB)
    const allEvidenceIds = [...new Set(parsed.flatMap((c) => c.evidenceIds))];
    const evidence = await this.readEvidence(allEvidenceIds);
    const existingIds = new Set(evidence.map((e) => e.id));

    for (const evidenceId of allEvidenceIds) {
      if (!existingIds.has(evidenceId)) {
        throw new ValidationError(`Evidence ${evidenceId} does not exist in database`);
      }
    }

    // Layer 3: Run membership check
    const allowed = new Set(allowedEvidenceIds);
    for (const claim of parsed) {
      for (const evidenceId of claim.evidenceIds) {
        if (!allowed.has(evidenceId)) {
          throw new ValidationError(
            `Evidence ${evidenceId} not in allowed set for this run. ` +
              `Allowed: ${allowedEvidenceIds.join(', ')}`,
          );
        }
      }
    }

    return parsed;
  }

  /**
   * Invariant "yang dilihat = yang dicatat" (addendum §24-B.1) — assertion
   * **inklusi**, bukan equality: `evidenceIds` harus subset dari `seenIds`
   * (evidence block zona [1] yang benar-benar dikirim ke LLM pesan itu).
   * Melempar `ValidationError` (bukan log warning) — auditability adalah
   * jaminan, bukan niat.
   */
  assertSeenEvidence(evidenceIds: string[], seenIds: string[]): void {
    const seen = new Set(seenIds);
    for (const id of evidenceIds) {
      if (!seen.has(id)) {
        throw new ValidationError(
          `Evidence ${id} references data the agent never saw. ` +
            `Seen evidence ids: ${seenIds.join(', ') || '(none)'}`,
        );
      }
    }
  }
}
