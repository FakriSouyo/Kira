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
} from './attachment';
import { type AttachmentTools } from '../tools/attachment';
import { createDocumentCapabilityGrants, createDocumentCapabilityRegistrations } from './document';
import { type DocumentTools } from '../tools/document';
import {
  createFinancialCapabilityGrants,
  createFinancialCapabilityRegistrations,
} from './financial';
import { type FinancialTools } from '../tools/financial';

export interface ApplicationCapabilityOptions {
  readonly financialTools: FinancialTools;
  readonly attachmentTools: AttachmentTools;
  readonly documentTools: DocumentTools;
  readonly toolRuntime: ToolRuntime;
}

export function createApplicationCapabilityRegistrations({
  financialTools,
  attachmentTools,
  documentTools,
}: Pick<ApplicationCapabilityOptions, 'financialTools' | 'attachmentTools' | 'documentTools'>) {
  return Object.freeze([
    ...createFinancialCapabilityRegistrations(financialTools),
    ...createAttachmentCapabilityRegistrations(attachmentTools),
    ...createDocumentCapabilityRegistrations(documentTools),
  ] as const);
}

export function createApplicationCapabilityGrants(): readonly CapabilityGrant[] {
  return Object.freeze([
    ...createFinancialCapabilityGrants(),
    ...createAttachmentCapabilityGrants(),
    ...createDocumentCapabilityGrants(),
  ]);
}

export function createApplicationCapabilityGateway({
  financialTools,
  attachmentTools,
  documentTools,
  toolRuntime,
}: ApplicationCapabilityOptions) {
  const registry = new CapabilityRegistry(
    createApplicationCapabilityRegistrations({ financialTools, attachmentTools, documentTools }),
  );
  const policy = new CapabilityPolicy(createApplicationCapabilityGrants());
  return new CapabilityGateway({ registry, policy, toolRuntime });
}

export type ApplicationCapabilityGateway = ReturnType<typeof createApplicationCapabilityGateway>;
