export {
  type CapabilityDescriptor,
  type CapabilityRegistration,
  type AnyCapabilityRegistration,
  type CapabilityGrant,
  type CapabilityPrincipal,
  type CapabilityToolForId,
  type CapabilityToolOutputForId,
} from './contracts.js';
export {
  CapabilityRegistryError,
  type CapabilityRegistryErrorCode,
  CapabilityPolicyError,
  type CapabilityPolicyErrorCode,
  CapabilityAccessError,
  type CapabilityAccessErrorCode,
} from './errors.js';
export { CapabilityRegistry } from './registry.js';
export { CapabilityPolicy } from './policy.js';
export {
  CapabilityGateway,
  type CapabilityGatewayOptions,
} from './gateway.js';
export {
  CAPABILITY_PLAN_SCHEMA_VERSION,
  createCapabilityPlan,
  validateCapabilityPlan,
  type CapabilityPlan,
  type CapabilityPlanEntry,
  type CapabilityPlanPrincipal,
} from './plan.js';
export { CapabilityPlanError, type CapabilityPlanErrorCode } from './errors.js';
