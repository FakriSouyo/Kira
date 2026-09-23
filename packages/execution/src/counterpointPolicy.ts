import { createHash } from 'node:crypto';
import {
  BearProposalOutputSchema,
  GroundedCounterpointSchema,
  type BearProposalOutput,
  type BearCounterpointProposal,
  type CounterpointEvidenceLink,
  type GroundedCounterpoint,
  type Evidence,
} from '@harness/schemas';
import { canonicalJson, UserFriendlyError, ValidationError } from '@harness/shared';
import type { EvidenceStore } from '@harness/evidence';
import { matchesGroundedNumber, numericAssertions, numericValueAtPath } from './numericGrounding';

export const COUNTERPOINT_POLICY_VERSION = 1 as const;
export const COUNTERPOINT_POLICY_ID = `counterpoint-policy-v${COUNTERPOINT_POLICY_VERSION}` as const;

const COUNTERPOINT_POLICY_DESCRIPTOR = {
  id: COUNTERPOINT_POLICY_ID,
  sourceNodeIds: ['round-1-bear-challenge', 'conditional-bear-rechallenge'],
  targetClaims: 'explicit-allowed-claim-id-set',
  evidence: 'unique-ids-links-set-parity-response-seen-allowed-execution-membership',
  citedFigures: 'must-reference-counterpoint-linked-evidence',
  numeric: 'literal-percent-multiple-bps-tolerance-0.5',
} as const;

export const COUNTERPOINT_POLICY_FINGERPRINT = createHash('sha256')
  .update(canonicalJson(COUNTERPOINT_POLICY_DESCRIPTOR), 'utf8')
  .digest('hex');

export const COUNTERPOINT_SOURCE_NODE_IDS = ['round-1-bear-challenge', 'conditional-bear-rechallenge'] as const;
export type CounterpointSourceNodeId = typeof COUNTERPOINT_SOURCE_NODE_IDS[number];

export interface CounterpointGroundingRequest {
  executionId: string;
  sourceNodeId: CounterpointSourceNodeId;
  response: BearProposalOutput;
  allowedEvidenceIds: readonly string[];
  seenEvidenceIds: readonly string[];
  allowedTargetClaimIds: readonly string[];
}

function assertLinkIntegrity(counterpoint: BearCounterpointProposal): void {
  if (counterpoint.evidenceIds.length !== new Set(counterpoint.evidenceIds).size) {
    throw new ValidationError(`Counterpoint targeting ${counterpoint.targetClaimId} has duplicate Evidence IDs`);
  }
  const links = counterpoint.evidenceLinks;
  const linkIds = links.map((link: CounterpointEvidenceLink) => link.evidenceId);
  if (linkIds.length !== new Set(linkIds).size) {
    throw new ValidationError(`Counterpoint targeting ${counterpoint.targetClaimId} has duplicate Evidence links`);
  }
  const linked = new Set(linkIds);
  if (counterpoint.evidenceIds.length !== linked.size || counterpoint.evidenceIds.some(id => !linked.has(id))) {
    throw new ValidationError(`Counterpoint targeting ${counterpoint.targetClaimId} Evidence links must match evidenceIds`);
  }
  if (counterpoint.citedFigures?.some(figure => !linked.has(figure.evidenceId))) {
    throw new ValidationError(`Counterpoint targeting ${counterpoint.targetClaimId} has an unlinked CitedFigure`);
  }
}

/** Turns a strict Bear proposal into a canonical Evidence- and Claim-scoped Counterpoint. */
export class CounterpointPolicy {
  constructor(private readonly evidenceStore: EvidenceStore) {}

  async ground(request: CounterpointGroundingRequest): Promise<GroundedCounterpoint[]> {
    if (!request.executionId) throw new ValidationError('Counterpoint Policy requires an Execution identity');
    if (!(COUNTERPOINT_SOURCE_NODE_IDS as readonly string[]).includes(request.sourceNodeId)) {
      throw new ValidationError(`Counterpoint Policy does not accept sourceNodeId ${String(request.sourceNodeId)}`);
    }
    const response = BearProposalOutputSchema.parse(request.response);
    const allowed = new Set(request.allowedEvidenceIds);
    const seen = new Set(request.seenEvidenceIds);
    const allowedTargets = new Set(request.allowedTargetClaimIds);
    const responseIds = [...new Set(response.evidenceIds)];
    const responseSet = new Set(responseIds);

    for (const id of responseIds) {
      if (!seen.has(id)) throw new ValidationError(`Bear response Evidence ${id} was never seen by the producer`);
      if (!allowed.has(id)) throw new ValidationError(`Bear response Evidence ${id} is outside the allowed set`);
    }

    for (const proposal of response.counterpoints) {
      if (!allowedTargets.has(proposal.targetClaimId)) {
        throw new ValidationError(`Counterpoint targets unknown Claim ${proposal.targetClaimId}`);
      }
      assertLinkIntegrity(proposal);
      for (const id of proposal.evidenceIds) {
        if (!responseSet.has(id)) throw new ValidationError(`Counterpoint Evidence ${id} is not covered by Bear response.evidenceIds`);
        if (!seen.has(id)) throw new ValidationError(`Counterpoint Evidence ${id} was never seen by the producer`);
        if (!allowed.has(id)) throw new ValidationError(`Counterpoint Evidence ${id} is outside the allowed set`);
      }
    }

    const ids = [...new Set([...responseIds, ...response.counterpoints.flatMap(point => point.evidenceIds)])];
    let evidence: Evidence[];
    try {
      evidence = await this.evidenceStore.getManyByIdsForRun(request.executionId, ids);
    } catch (cause) {
      throw new UserFriendlyError('VALIDATION_UNAVAILABLE', `Counterpoint Evidence scope could not be read: ${String(cause)}`, 'Retry when Evidence storage is available.');
    }
    const byId = new Map(evidence.map(item => [item.id, item]));
    for (const id of ids) {
      if (!byId.has(id)) throw new ValidationError(`Evidence ${id} is outside Execution ${request.executionId} membership`);
    }

    return response.counterpoints.map((proposal, index) => {
      const groundedFigures: Array<{ cited: number; actual: number }> = [];
      for (const figure of proposal.citedFigures ?? []) {
        const actual = numericValueAtPath(byId.get(figure.evidenceId)?.data, figure.path);
        if (actual === undefined) throw new ValidationError(`Counterpoint Evidence path ${figure.path} is missing`);
        if (typeof actual !== 'number' || !matchesGroundedNumber(actual, figure.value)) {
          throw new ValidationError(`Counterpoint CitedFigure value mismatch at ${figure.path}`);
        }
        groundedFigures.push({ cited: figure.value, actual });
      }
      for (const assertion of numericAssertions(proposal.argument)) {
        if (!groundedFigures.some(figure => matchesGroundedNumber(assertion, figure.cited)
          && matchesGroundedNumber(assertion, figure.actual))) {
          throw new ValidationError(`Counterpoint numeric argument has no matching grounded CitedFigure`);
        }
      }

      return GroundedCounterpointSchema.parse({
        ...proposal,
        counterpointId: `counterpoint:${request.sourceNodeId}:${index + 1}`,
        sourceNodeId: request.sourceNodeId,
        policyId: COUNTERPOINT_POLICY_ID,
        policyFingerprint: COUNTERPOINT_POLICY_FINGERPRINT,
      });
    });
  }
}
