import type { ToolDefinition } from '@harness/tool-runtime';

export interface CapabilityDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly kind: 'tool';
  readonly integrationId: string;
}

export interface CapabilityRegistration<
  TTool extends ToolDefinition<any, any, any>,
> {
  readonly descriptor: CapabilityDescriptor;
  readonly tool: TTool;
}

export interface CapabilityPrincipal {
  readonly id: string;
}

export interface CapabilityGrant {
  readonly principalId: string;
  readonly capabilityIds: readonly string[];
}

export type AnyCapabilityRegistration = CapabilityRegistration<
  ToolDefinition<string, any, any>
>;

export type CapabilityToolForId<
  TRegistrations extends readonly AnyCapabilityRegistration[],
  TId extends string,
> = Extract<TRegistrations[number]['tool'], { readonly id: TId }> extends infer TTool
  ? [TTool] extends [never]
    ? ToolDefinition<string, any, any>
    : TTool
  : never;

export type CapabilityToolOutputForId<
  TRegistrations extends readonly AnyCapabilityRegistration[],
  TId extends string,
> = CapabilityToolForId<TRegistrations, TId> extends ToolDefinition<
  any,
  any,
  infer TOutput
>
  ? TOutput
  : unknown;
