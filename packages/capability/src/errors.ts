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
