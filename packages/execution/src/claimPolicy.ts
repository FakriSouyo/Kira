import { createHash } from 'node:crypto';
import { BullProposalOutputSchema, type BullProposalOutput, type Claim, type ClaimEvidenceLink, type Evidence } from '@harness/schemas';
import { canonicalJson, UserFriendlyError, ValidationError } from '@harness/shared';
import type { EvidenceStore } from '@harness/evidence';
import { detectSingleMetricFlags } from './claimValidator';

export const CLAIM_POLICY_VERSION = 1 as const;
export const CLAIM_POLICY_ID = `claim-policy-v${CLAIM_POLICY_VERSION}` as const;
export const CLAIM_POLICY_FINGERPRINT = createHash('sha256').update(canonicalJson({
  id: CLAIM_POLICY_ID,
  evidenceIds: 'unique',
  links: 'explicit-set-parity-and-seen-scope',
  numeric: 'literal-percent-multiple-bps-tolerance-0.5',
  annotation: 'deterministic-single-metric',
})).digest('hex');

export type GroundedClaim = Claim & {
  evidenceLinks: ClaimEvidenceLink[];
  policyId: typeof CLAIM_POLICY_ID;
  policyFingerprint: string;
};

export interface ClaimGroundingRequest {
  executionId: string;
  response: BullProposalOutput;
  allowedEvidenceIds: readonly string[];
  seenEvidenceIds: readonly string[];
}

const NUMERIC_TOLERANCE = 0.5;
/** Supported literal statement assertions: a number followed by %, x, or bps. */
function numericAssertions(statement: string): number[] {
  const values: number[] = [];
  const pattern = /(?<![\w.])-?\d+(?:\.\d+)?\s*(?:%|x|bps)(?![\w])/gi;
  for (const match of statement.matchAll(pattern)) {
    const value = Number.parseFloat(match[0]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function valueAtPath(data: unknown, path: string): unknown {
  if (!/^[a-zA-Z_$][\w$]*(?:(?:\.(?:[a-zA-Z_$][\w$]*|\d+))|(?:\[\d+\]))*$/.test(path)) return undefined;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function sameValue(left: number, right: number): boolean {
  return Math.abs(left - right) <= NUMERIC_TOLERANCE;
}

/** Converts one current Bull model response into canonical, execution-grounded Claims. */
export class ClaimPolicy {
  constructor(private readonly evidenceStore: EvidenceStore) {}

  async ground(request: ClaimGroundingRequest): Promise<GroundedClaim[]> {
    if (!request.executionId) throw new ValidationError('Claim Policy requires an Execution identity');
    const response = BullProposalOutputSchema.parse(request.response);
    const allowed = new Set(request.allowedEvidenceIds);
    const seen = new Set(request.seenEvidenceIds);
    for (const claim of response.claims) {
      if (claim.evidenceIds.length !== new Set(claim.evidenceIds).size) {
        throw new ValidationError(`Claim ${claim.claimId} has duplicate Evidence IDs`);
      }
    }
    const claimIds = new Set(response.claims.flatMap(claim => claim.evidenceIds));
    const responseIds = new Set(response.evidenceIds);
    for (const id of claimIds) {
      if (!responseIds.has(id)) throw new ValidationError(`Claim Evidence ${id} is not covered by Bull response.evidenceIds`);
    }
    for (const id of responseIds) {
      if (!seen.has(id)) throw new ValidationError(`Bull response Evidence ${id} was never seen by the producer`);
      if (!allowed.has(id)) throw new ValidationError(`Bull response Evidence ${id} is outside the allowed set`);
    }
    for (const claim of response.claims) {
      const linked = new Set<string>();
      for (const link of claim.evidenceLinks) {
        if (linked.has(link.evidenceId)) throw new ValidationError(`Claim ${claim.claimId} has duplicate Evidence links`);
        linked.add(link.evidenceId);
      }
      if (linked.size !== new Set(claim.evidenceIds).size || claim.evidenceIds.some(id => !linked.has(id))) {
        throw new ValidationError(`Claim ${claim.claimId} Evidence links must match evidenceIds`);
      }
      for (const id of linked) {
        if (!allowed.has(id)) throw new ValidationError(`Claim ${claim.claimId} Evidence ${id} is outside the allowed set`);
        if (!seen.has(id)) throw new ValidationError(`Claim ${claim.claimId} Evidence ${id} was never seen by the producer`);
      }
      for (const figure of claim.citedFigures ?? []) {
        if (!linked.has(figure.evidenceId)) throw new ValidationError(`Claim ${claim.claimId} figure Evidence is not linked`);
      }
    }
    const ids = [...new Set([...responseIds, ...claimIds])];
    let evidence: Evidence[];
    try {
      evidence = await this.evidenceStore.getManyByIdsForRun(request.executionId, ids);
    } catch (cause) {
      throw new UserFriendlyError('VALIDATION_UNAVAILABLE', `Claim Evidence scope could not be read: ${String(cause)}`, 'Retry when Evidence storage is available.');
    }
    const byId = new Map(evidence.map(item => [item.id, item]));
    for (const id of ids) {
      if (!byId.has(id)) throw new ValidationError(`Evidence ${id} is outside Execution ${request.executionId} membership`);
    }
    for (const claim of response.claims) {
      const groundedFigures: Array<{ cited: number; actual: number }> = [];
      for (const figure of claim.citedFigures ?? []) {
        const actual = valueAtPath(byId.get(figure.evidenceId)?.data, figure.path);
        if (actual === undefined) throw new ValidationError(`Claim ${claim.claimId} Evidence path ${figure.path} is missing`);
        if (typeof actual !== 'number' || !sameValue(actual, figure.value)) {
          throw new ValidationError(`Claim ${claim.claimId} CitedFigure value mismatch at ${figure.path}`);
        }
        groundedFigures.push({ cited: figure.value, actual });
      }
      for (const assertion of numericAssertions(claim.statement)) {
        if (!groundedFigures.some(figure => sameValue(assertion, figure.cited) && sameValue(assertion, figure.actual))) {
          throw new ValidationError(`Claim ${claim.claimId} numeric statement has no matching grounded CitedFigure`);
        }
      }
    }
    let scope: Evidence[];
    try {
      scope = await this.evidenceStore.getByRun(request.executionId);
    } catch (cause) {
      throw new UserFriendlyError('VALIDATION_UNAVAILABLE', `Claim reconciliation scope could not be read: ${String(cause)}`, 'Retry when Evidence storage is available.');
    }
    const annotations = detectSingleMetricFlags(response.claims,
      new Map(scope.filter(item => seen.has(item.id) && allowed.has(item.id)).map(item => [item.id, item])));
    return annotations.map((claim, index) => ({
      ...claim,
      evidenceLinks: response.claims[index]!.evidenceLinks,
      policyId: CLAIM_POLICY_ID,
      policyFingerprint: CLAIM_POLICY_FINGERPRINT,
    }));
  }
}
