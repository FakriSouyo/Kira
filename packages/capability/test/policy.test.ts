import { describe, expect, it } from 'vitest';

import {
  CapabilityAccessError,
  CapabilityPolicy,
  CapabilityPolicyError,
  type CapabilityGrant,
  type CapabilityPrincipal,
} from '../src/index.js';

const analyst: CapabilityPrincipal = { id: 'analyst' };

describe('CapabilityPolicy', () => {
  it('creates a detached, frozen, deterministic grant listing', () => {
    const grants = [
      { principalId: 'zeta', capabilityIds: ['cap.b', 'cap.a'] },
      { principalId: 'alpha', capabilityIds: ['cap.z'] },
    ] satisfies CapabilityGrant[];
    const policy = new CapabilityPolicy(grants);

    grants[0].capabilityIds.push('cap.m');
    grants.push({ principalId: 'later', capabilityIds: ['cap.later'] });

    const listed = policy.list();

    expect(listed).toEqual([
      { principalId: 'alpha', capabilityIds: ['cap.z'] },
      { principalId: 'zeta', capabilityIds: ['cap.a', 'cap.b'] },
    ]);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
    expect(Object.isFrozen(listed[0].capabilityIds)).toBe(true);
    expect(policy.list()).not.toBe(listed);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy).not.toHaveProperty('execute');
    expect(policy).not.toHaveProperty('invoke');
  });

  it('allows only exact principal and capability grant matches', () => {
    const policy = new CapabilityPolicy([
      { principalId: 'analyst', capabilityIds: ['financial.report'] },
    ]);

    expect(policy.allows(analyst, 'financial.report')).toBe(true);
    expect(policy.allows(analyst, 'financial.report.extra')).toBe(false);
    expect(policy.allows({ id: 'unknown' }, 'financial.report')).toBe(false);
    expect(policy.allows(analyst, 'unknown.capability')).toBe(false);
  });

  it('rejects invalid policy configuration and caller principals', () => {
    expect(() => new CapabilityPolicy([{ principalId: '', capabilityIds: ['cap.a'] }])).toThrowError(
      new CapabilityPolicyError('INVALID_CAPABILITY_PRINCIPAL', 'Capability principal ID must be non-empty'),
    );
    expect(() => new CapabilityPolicy([{ principalId: 'analyst', capabilityIds: [''] }])).toThrowError(
      new CapabilityPolicyError('INVALID_CAPABILITY_POLICY', 'Capability ID must be non-empty'),
    );
    expect(
      () => new CapabilityPolicy([{ principalId: 'analyst', capabilityIds: ['cap.a', 'cap.a'] }]),
    ).toThrowError(expect.objectContaining({ code: 'DUPLICATE_CAPABILITY_ID' }));
    expect(
      () => new CapabilityPolicy([
        { principalId: 'analyst', capabilityIds: ['cap.a'] },
        { principalId: 'analyst', capabilityIds: ['cap.b'] },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'DUPLICATE_CAPABILITY_PRINCIPAL' }));

    expect(() => policyForTests().authorize({ id: '' }, 'cap.a')).toThrowError(
      new CapabilityPolicyError('INVALID_CAPABILITY_PRINCIPAL', 'Capability principal ID must be non-empty'),
    );
  });

  it('reports denied access separately from policy configuration errors', () => {
    const policy = policyForTests();

    expect(() => policy.authorize(analyst, 'cap.denied')).toThrowError(
      new CapabilityAccessError('CAPABILITY_DENIED', 'Capability cap.denied is not granted to principal analyst'),
    );
  });
});

function policyForTests(): CapabilityPolicy {
  return new CapabilityPolicy([{ principalId: 'analyst', capabilityIds: ['cap.a'] }]);
}
