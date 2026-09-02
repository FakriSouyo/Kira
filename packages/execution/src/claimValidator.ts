import { ClaimSchema, type Claim } from '@harness/schemas';
import { ValidationError } from '@harness/shared';
import type { EvidenceStore } from '@harness/evidence';

/**
 * Validasi claim 3 lapis (addendum §16):
 *   Layer 1 — struktur (Zod)
 *   Layer 2 — evidence ada di DB
 *   Layer 3 — evidence termasuk allowed set milik run ini
 */
export class ClaimValidator {
  constructor(private readonly evidenceStore: EvidenceStore) {}

  async validate(claims: Claim[], allowedEvidenceIds: string[]): Promise<Claim[]> {
    // Layer 1: Structural validation (Zod)
    const parsed = ClaimSchema.array().parse(claims);

    // Layer 2: Evidence existence check (DB)
    const allEvidenceIds = [...new Set(parsed.flatMap((c) => c.evidenceIds))];
    const evidence = await this.evidenceStore.getManyByIds(allEvidenceIds);
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
}
