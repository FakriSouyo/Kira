import type { CapabilityGrant, CapabilityRegistration } from '@harness/capability';
import { attachmentToolIds, type AttachmentTools } from '../tools/attachment';

export const ATTACHMENT_CAPABILITY_INTEGRATION_ID = 'attachment-store' as const;

export const COMMAND_FILES_CAPABILITY_PRINCIPAL = Object.freeze({
  id: 'command.files',
} as const);

export const COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL = Object.freeze({
  id: 'command.doc-index',
} as const);

function registration<TTool extends AttachmentTools[keyof AttachmentTools]>(
  tool: TTool,
  displayName: string,
  description: string,
): CapabilityRegistration<TTool> {
  return Object.freeze({
    descriptor: Object.freeze({
      id: tool.id,
      displayName,
      description,
      kind: 'tool' as const,
      integrationId: ATTACHMENT_CAPABILITY_INTEGRATION_ID,
    }),
    tool,
  });
}

export function createAttachmentCapabilityRegistrations(tools: AttachmentTools) {
  return Object.freeze([
    registration(
      tools.list,
      'List Session Attachments',
      'List raw attachments owned by the active Kira Session.',
    ),
    registration(
      tools.describe,
      'Describe Attachment',
      'Read metadata for one raw attachment owned by the active Kira Session.',
    ),
    registration(
      tools.read,
      'Read Attachment',
      'Read exact raw bytes for one attachment owned by the active Kira Session.',
    ),
  ] as const);
}

export function createAttachmentCapabilityGrants(): readonly CapabilityGrant[] {
  return Object.freeze([
    {
      principalId: COMMAND_FILES_CAPABILITY_PRINCIPAL.id,
      capabilityIds: [attachmentToolIds.list],
    },
    {
      principalId: COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL.id,
      capabilityIds: [attachmentToolIds.read],
    },
  ]);
}
