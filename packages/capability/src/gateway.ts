import type {
  ToolDefinition,
  ToolInvocationOptions,
  ToolInvocationResult,
  ToolRuntime,
} from '@harness/tool-runtime';

import type {
  AnyCapabilityRegistration,
  CapabilityDescriptor,
  CapabilityPrincipal,
  CapabilityToolOutputForId,
} from './contracts.js';
import { CapabilityPolicy } from './policy.js';
import { CapabilityRegistry } from './registry.js';

export interface CapabilityGatewayOptions<
  TRegistrations extends readonly AnyCapabilityRegistration[],
> {
  readonly registry: CapabilityRegistry<TRegistrations>;
  readonly policy: CapabilityPolicy;
  readonly toolRuntime: ToolRuntime;
}

export class CapabilityGateway<
  TRegistrations extends readonly AnyCapabilityRegistration[] = readonly AnyCapabilityRegistration[],
> {
  private readonly registry: CapabilityRegistry<TRegistrations>;
  private readonly policy: CapabilityPolicy;
  private readonly toolRuntime: ToolRuntime;

  constructor(options: CapabilityGatewayOptions<TRegistrations>) {
    this.registry = options.registry;
    this.policy = options.policy;
    this.toolRuntime = options.toolRuntime;

    for (const grant of this.policy.list()) {
      for (const capabilityId of grant.capabilityIds) {
        this.registry.describe(capabilityId);
      }
    }

    Object.freeze(this);
  }

  list(principal: CapabilityPrincipal): readonly CapabilityDescriptor[] {
    const authorizedIds = new Set(this.policy.capabilitiesFor(principal));
    return Object.freeze(
      this.registry.list().filter((descriptor) => authorizedIds.has(descriptor.id)),
    );
  }

  describe(principal: CapabilityPrincipal, capabilityId: string): CapabilityDescriptor {
    this.policy.capabilitiesFor(principal);
    const descriptor = this.registry.describe(capabilityId);
    this.policy.authorize(principal, descriptor.id);
    return descriptor;
  }

  async invoke<TId extends string>(
    principal: CapabilityPrincipal,
    capabilityId: TId,
    input: unknown,
    options?: ToolInvocationOptions,
  ): Promise<ToolInvocationResult<CapabilityToolOutputForId<TRegistrations, TId>>> {
    this.policy.capabilitiesFor(principal);
    this.registry.describe(capabilityId);
    this.policy.authorize(principal, capabilityId);
    const tool = this.registry.resolveTool(capabilityId);

    return this.toolRuntime.invoke(
      tool as ToolDefinition<string, any, CapabilityToolOutputForId<TRegistrations, TId>>,
      input,
      options,
    );
  }
}
