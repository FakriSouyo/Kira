import type { CapabilityGrant, CapabilityRegistration } from '@harness/capability';
import { documentToolIds, type DocumentTools } from './documentTools';

export const DOCUMENT_CAPABILITY_INTEGRATION_ID = 'document-store' as const;

export const COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL = Object.freeze({
  id: 'command.doc-search',
} as const);

function registration<TTool extends DocumentTools[keyof DocumentTools]>(
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
      integrationId: DOCUMENT_CAPABILITY_INTEGRATION_ID,
    }),
    tool,
  });
}

export function createDocumentCapabilityRegistrations(tools: DocumentTools) {
  return Object.freeze([
    registration(
      tools.search,
      'Search Indexed Documents',
      'Search deterministic extracted chunks owned by the active FinHarness Session.',
    ),
  ] as const);
}

export function createDocumentCapabilityGrants(): readonly CapabilityGrant[] {
  return Object.freeze([{
    principalId: COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL.id,
    capabilityIds: [documentToolIds.search],
  }]);
}
