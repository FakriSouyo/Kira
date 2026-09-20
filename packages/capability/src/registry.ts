import type { ToolDefinition } from '@harness/tool-runtime';
import {
  type CapabilityDescriptor,
  type CapabilityRegistration,
} from './contracts.js';
import { CapabilityRegistryError } from './errors.js';

type AnyToolDefinition = ToolDefinition<string, any, any>;
type AnyCapabilityRegistration = CapabilityRegistration<AnyToolDefinition>;

type ResolvedTool<
  TRegistrations extends readonly AnyCapabilityRegistration[],
  TId extends string,
> = Extract<TRegistrations[number]['tool'], { readonly id: TId }> extends infer TTool
  ? [TTool] extends [never]
    ? AnyToolDefinition
    : TTool
  : never;

function invalid(message: string): never {
  throw new CapabilityRegistryError('INVALID_CAPABILITY_REGISTRATION', message);
}

function requiredString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${label} must be non-empty`);
  }
}

function isToolDefinition(value: unknown): value is AnyToolDefinition {
  if (value === null || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof (candidate.inputSchema as { parse?: unknown } | undefined)?.parse === 'function' &&
    typeof (candidate.outputSchema as { parse?: unknown } | undefined)?.parse === 'function' &&
    typeof candidate.execute === 'function'
  );
}

function freezeDescriptor(descriptor: CapabilityDescriptor): CapabilityDescriptor {
  return Object.freeze({
    id: descriptor.id,
    displayName: descriptor.displayName,
    description: descriptor.description,
    kind: descriptor.kind,
    integrationId: descriptor.integrationId,
  });
}

function validateRegistration(
  registration: AnyCapabilityRegistration,
): { readonly descriptor: CapabilityDescriptor; readonly tool: AnyToolDefinition } {
  if (registration === null || typeof registration !== 'object') {
    return invalid('Capability registration must be an object');
  }

  const descriptor = registration.descriptor;
  if (descriptor === null || typeof descriptor !== 'object') {
    return invalid('Capability descriptor must be an object');
  }

  requiredString(descriptor.id, 'capability id');
  requiredString(descriptor.displayName, `display name for capability ${descriptor.id}`);
  requiredString(descriptor.description, `description for capability ${descriptor.id}`);
  requiredString(descriptor.integrationId, `integration id for capability ${descriptor.id}`);
  if (descriptor.kind !== 'tool') {
    return invalid(`Capability ${descriptor.id} must have kind "tool"`);
  }

  if (!isToolDefinition(registration.tool)) {
    return invalid(`Capability ${descriptor.id} has an invalid tool definition`);
  }
  if (descriptor.id !== registration.tool.id) {
    return invalid(
      `Capability descriptor ID ${descriptor.id} does not match tool ID ${registration.tool.id}`,
    );
  }

  return { descriptor: freezeDescriptor(descriptor), tool: registration.tool };
}

export class CapabilityRegistry<
  TRegistrations extends readonly AnyCapabilityRegistration[] = readonly AnyCapabilityRegistration[],
> {
  private readonly descriptors: ReadonlyMap<string, CapabilityDescriptor>;
  private readonly tools: ReadonlyMap<string, AnyToolDefinition>;

  constructor(registrations: TRegistrations) {
    const descriptors = new Map<string, CapabilityDescriptor>();
    const tools = new Map<string, AnyToolDefinition>();

    for (const registration of registrations) {
      const validated = validateRegistration(registration);
      if (descriptors.has(validated.descriptor.id)) {
        throw new CapabilityRegistryError(
          'DUPLICATE_CAPABILITY',
          `Capability ${validated.descriptor.id} is registered more than once`,
        );
      }
      descriptors.set(validated.descriptor.id, validated.descriptor);
      tools.set(validated.descriptor.id, validated.tool);
    }

    this.descriptors = descriptors;
    this.tools = tools;
  }

  list(): readonly CapabilityDescriptor[] {
    return Object.freeze(
      [...this.descriptors.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(freezeDescriptor),
    );
  }

  describe(id: string): CapabilityDescriptor {
    const descriptor = this.descriptors.get(id);
    if (!descriptor) {
      throw new CapabilityRegistryError('UNKNOWN_CAPABILITY', `Unknown capability: ${id}`);
    }
    return freezeDescriptor(descriptor);
  }

  /** @internal Trusted composition code only; this never executes the tool. */
  resolveTool<TId extends string>(id: TId): ResolvedTool<TRegistrations, TId> {
    const tool = this.tools.get(id);
    if (!tool) {
      throw new CapabilityRegistryError('UNKNOWN_CAPABILITY', `Unknown capability: ${id}`);
    }
    return tool as ResolvedTool<TRegistrations, TId>;
  }
}
