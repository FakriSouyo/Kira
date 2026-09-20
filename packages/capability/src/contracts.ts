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
