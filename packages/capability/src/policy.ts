import type { CapabilityGrant, CapabilityPrincipal } from './contracts.js';
import {
  CapabilityAccessError,
  CapabilityPolicyError,
} from './errors.js';

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CapabilityPolicyError(
      label === 'principal' ? 'INVALID_CAPABILITY_PRINCIPAL' : 'INVALID_CAPABILITY_POLICY',
      label === 'principal'
        ? 'Capability principal ID must be non-empty'
        : 'Capability ID must be non-empty',
    );
  }
  return value;
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function freezeGrant(principalId: string, capabilityIds: readonly string[]): CapabilityGrant {
  return Object.freeze({
    principalId,
    capabilityIds: Object.freeze([...capabilityIds]),
  });
}

export class CapabilityPolicy {
  private readonly grants: readonly CapabilityGrant[];

  constructor(grants: readonly CapabilityGrant[]) {
    if (!Array.isArray(grants)) {
      throw new CapabilityPolicyError(
        'INVALID_CAPABILITY_POLICY',
        'Capability policy grants must be an array',
      );
    }

    const principalIds = new Set<string>();
    const normalizedGrants: CapabilityGrant[] = [];

    for (const grant of grants) {
      if (grant === null || typeof grant !== 'object') {
        throw new CapabilityPolicyError(
          'INVALID_CAPABILITY_POLICY',
          'Capability grant must be an object',
        );
      }

      const principalId = requireId(grant.principalId, 'principal');
      if (principalIds.has(principalId)) {
        throw new CapabilityPolicyError(
          'DUPLICATE_CAPABILITY_PRINCIPAL',
          `Capability principal ${principalId} is granted more than once`,
        );
      }
      principalIds.add(principalId);

      if (!Array.isArray(grant.capabilityIds)) {
        throw new CapabilityPolicyError(
          'INVALID_CAPABILITY_POLICY',
          `Capability grant for principal ${principalId} must contain an array of capability IDs`,
        );
      }

      const capabilityIds = [...grant.capabilityIds];
      const uniqueCapabilityIds = new Set<string>();
      for (const capabilityId of capabilityIds) {
        requireId(capabilityId, 'capability');
        if (uniqueCapabilityIds.has(capabilityId)) {
          throw new CapabilityPolicyError(
            'DUPLICATE_CAPABILITY_ID',
            `Capability ${capabilityId} is repeated for principal ${principalId}`,
          );
        }
        uniqueCapabilityIds.add(capabilityId);
      }

      const sortedCapabilityIds = capabilityIds.sort(compareIds);
      normalizedGrants.push(freezeGrant(principalId, sortedCapabilityIds));
    }

    normalizedGrants.sort((left, right) => compareIds(left.principalId, right.principalId));
    this.grants = Object.freeze(normalizedGrants);
    Object.freeze(this);
  }

  list(): readonly CapabilityGrant[] {
    return Object.freeze(
      this.grants.map((grant) => freezeGrant(grant.principalId, grant.capabilityIds)),
    );
  }

  capabilitiesFor(principal: CapabilityPrincipal): readonly string[] {
    const principalId = requireId(principal?.id, 'principal');
    const grant = this.grants.find((candidate) => candidate.principalId === principalId);
    return Object.freeze(grant ? [...grant.capabilityIds].sort(compareIds) : []);
  }

  allows(principal: CapabilityPrincipal, capabilityId: string): boolean {
    return this.capabilitiesFor(principal).includes(capabilityId);
  }

  authorize(principal: CapabilityPrincipal, capabilityId: string): void {
    const principalId = requireId(principal?.id, 'principal');
    const grant = this.grants.find((candidate) => candidate.principalId === principalId);
    if (!grant?.capabilityIds.includes(capabilityId)) {
      throw new CapabilityAccessError(
        'CAPABILITY_DENIED',
        `Capability ${capabilityId} is not granted to principal ${principalId}`,
      );
    }
  }
}
