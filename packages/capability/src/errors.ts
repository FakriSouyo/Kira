export type CapabilityRegistryErrorCode =
  | 'UNKNOWN_CAPABILITY'
  | 'DUPLICATE_CAPABILITY'
  | 'INVALID_CAPABILITY_REGISTRATION';

export class CapabilityRegistryError extends Error {
  constructor(
    public readonly code: CapabilityRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityRegistryError';
  }
}

export type CapabilityPolicyErrorCode =
  | 'INVALID_CAPABILITY_POLICY'
  | 'INVALID_CAPABILITY_PRINCIPAL'
  | 'DUPLICATE_CAPABILITY_PRINCIPAL'
  | 'DUPLICATE_CAPABILITY_ID';

export class CapabilityPolicyError extends Error {
  constructor(
    public readonly code: CapabilityPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityPolicyError';
  }
}

export type CapabilityAccessErrorCode = 'CAPABILITY_DENIED';

export class CapabilityAccessError extends Error {
  constructor(
    public readonly code: CapabilityAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityAccessError';
  }
}

export type CapabilityPlanErrorCode = 'INVALID_CAPABILITY_PLAN';

export class CapabilityPlanError extends Error {
  constructor(
    public readonly code: CapabilityPlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityPlanError';
  }
}
