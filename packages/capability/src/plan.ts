import { createHash } from 'node:crypto';
import { canonicalJson } from '@harness/shared';
import type {
  CapabilityDescriptor,
  CapabilityPrincipal,
} from './contracts.js';
import { CapabilityPlanError } from './errors.js';
import type { CapabilityGateway } from './gateway.js';

export const CAPABILITY_PLAN_SCHEMA_VERSION = 1 as const;

export interface CapabilityPlanEntry {
  readonly id: string;
  readonly kind: CapabilityDescriptor['kind'];
  readonly integrationId: string;
}

export interface CapabilityPlanPrincipal {
  readonly principalId: string;
  readonly capabilities: readonly CapabilityPlanEntry[];
}

export interface CapabilityPlan {
  readonly schemaVersion: typeof CAPABILITY_PLAN_SCHEMA_VERSION;
  readonly principals: readonly CapabilityPlanPrincipal[];
  readonly fingerprint: string;
}

type CapabilityDiscovery = Pick<CapabilityGateway, 'list'>;

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CapabilityPlanError('INVALID_CAPABILITY_PLAN', `${label} must be a non-empty string`);
  }
  return value;
}

function invalidPlan(message: string): never {
  throw new CapabilityPlanError('INVALID_CAPABILITY_PLAN', message);
}

function planSemanticValue(
  gateway: CapabilityDiscovery,
  principals: readonly CapabilityPrincipal[],
): Omit<CapabilityPlan, 'fingerprint'> {
  const normalized = principals.map((principal): CapabilityPlanPrincipal => ({
    principalId: principal.id,
    capabilities: gateway.list(principal)
      .map((descriptor): CapabilityPlanEntry => ({
        id: descriptor.id,
        kind: descriptor.kind,
        integrationId: descriptor.integrationId,
      }))
      .sort((left, right) =>
        compare(left.id, right.id) ||
        compare(left.kind, right.kind) ||
        compare(left.integrationId, right.integrationId)),
  })).sort((left, right) => compare(left.principalId, right.principalId));

  return {
    schemaVersion: CAPABILITY_PLAN_SCHEMA_VERSION,
    principals: normalized,
  };
}

/** Builds a deterministic, scoped, data-only representation of effective capability authority. */
export function createCapabilityPlan(
  gateway: CapabilityDiscovery,
  principals: readonly CapabilityPrincipal[],
): CapabilityPlan {
  const semantic = planSemanticValue(gateway, principals);
  const fingerprint = createHash('sha256')
    .update(canonicalJson(semantic), 'utf8')
    .digest('hex');

  return validateCapabilityPlan({ ...semantic, fingerprint });
}

/** Validates and canonicalizes a persisted or externally supplied semantic capability plan. */
export function validateCapabilityPlan(value: unknown): CapabilityPlan {
  if (!isRecord(value) || value.schemaVersion !== CAPABILITY_PLAN_SCHEMA_VERSION) {
    return invalidPlan('Capability plan schemaVersion must be 1');
  }
  if (!Array.isArray(value.principals)) return invalidPlan('Capability plan principals must be an array');
  const suppliedFingerprint = requiredString(value.fingerprint, 'Capability plan fingerprint');
  if (!/^[0-9a-f]{64}$/.test(suppliedFingerprint)) {
    return invalidPlan('Capability plan fingerprint must be a SHA-256 hexadecimal identity');
  }

  const principalIds = new Set<string>();
  const principals: CapabilityPlanPrincipal[] = value.principals.map((rawPrincipal, principalIndex) => {
    if (!isRecord(rawPrincipal)) return invalidPlan(`Capability plan principal ${principalIndex} must be an object`);
    const principalId = requiredString(rawPrincipal.principalId, `Capability plan principal ${principalIndex} principalId`);
    if (principalIds.has(principalId)) return invalidPlan(`Capability plan contains duplicate principalId ${principalId}`);
    principalIds.add(principalId);
    if (!Array.isArray(rawPrincipal.capabilities)) {
      return invalidPlan(`Capability plan principal ${principalId} capabilities must be an array`);
    }
    const capabilityIds = new Set<string>();
    const capabilities: CapabilityPlanEntry[] = rawPrincipal.capabilities.map((rawCapability, capabilityIndex) => {
      if (!isRecord(rawCapability)) return invalidPlan(`Capability plan capability ${principalId}[${capabilityIndex}] must be an object`);
      const id = requiredString(rawCapability.id, `Capability plan capability ${principalId}[${capabilityIndex}] id`);
      if (capabilityIds.has(id)) return invalidPlan(`Capability plan principal ${principalId} contains duplicate capability ID ${id}`);
      capabilityIds.add(id);
      if (rawCapability.kind !== 'tool') return invalidPlan(`Capability plan capability ${id} has an invalid kind`);
      const integrationId = requiredString(rawCapability.integrationId, `Capability plan capability ${id} integrationId`);
      return { id, kind: 'tool', integrationId };
    });
    capabilities.sort((left, right) =>
      compare(left.id, right.id) || compare(left.kind, right.kind) || compare(left.integrationId, right.integrationId));
    return { principalId, capabilities };
  });
  principals.sort((left, right) => compare(left.principalId, right.principalId));

  const semantic = { schemaVersion: CAPABILITY_PLAN_SCHEMA_VERSION, principals } satisfies Omit<CapabilityPlan, 'fingerprint'>;
  const expectedFingerprint = createHash('sha256')
    .update(canonicalJson(semantic), 'utf8')
    .digest('hex');
  if (suppliedFingerprint !== expectedFingerprint) {
    return invalidPlan('Capability plan fingerprint does not match its canonical semantic contents');
  }
  return deepFreeze({ ...semantic, fingerprint: suppliedFingerprint });
}
