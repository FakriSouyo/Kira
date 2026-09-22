import {
  CapabilityGateway,
  CapabilityPolicy,
  CapabilityRegistry,
  type CapabilityGrant,
} from '@harness/capability';
import type { ToolRuntime } from '@harness/tool-runtime';
import {
  createAttachmentCapabilityGrants,
  createAttachmentCapabilityRegistrations,
} from './attachmentCapabilities';
import { type AttachmentTools } from './attachmentTools';
import {
  createFinancialCapabilityGrants,
  createFinancialCapabilityRegistrations,
} from './financialCapabilities';
import { type FinancialTools } from './financialTools';

export interface ApplicationCapabilityOptions {
  readonly financialTools: FinancialTools;
  readonly attachmentTools: AttachmentTools;
  readonly toolRuntime: ToolRuntime;
}

export function createApplicationCapabilityRegistrations({
  financialTools,
  attachmentTools,
}: Pick<ApplicationCapabilityOptions, 'financialTools' | 'attachmentTools'>) {
  return Object.freeze([
    ...createFinancialCapabilityRegistrations(financialTools),
    ...createAttachmentCapabilityRegistrations(attachmentTools),
  ] as const);
}

export function createApplicationCapabilityGrants(): readonly CapabilityGrant[] {
  return Object.freeze([
    ...createFinancialCapabilityGrants(),
    ...createAttachmentCapabilityGrants(),
  ]);
}

export function createApplicationCapabilityGateway({
  financialTools,
  attachmentTools,
  toolRuntime,
}: ApplicationCapabilityOptions) {
  const registry = new CapabilityRegistry(
    createApplicationCapabilityRegistrations({ financialTools, attachmentTools }),
  );
  const policy = new CapabilityPolicy(createApplicationCapabilityGrants());
  return new CapabilityGateway({ registry, policy, toolRuntime });
}

export type ApplicationCapabilityGateway = ReturnType<typeof createApplicationCapabilityGateway>;
