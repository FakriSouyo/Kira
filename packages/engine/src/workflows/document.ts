import type { CapabilityGateway } from '@harness/capability';
import {
  buildDocumentBundle,
  type DocumentBundle,
  type DocumentSearchHit,
  type DocumentStore,
} from '@harness/document';
import { COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL } from '../capabilities/attachment.js';
import { COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL } from '../capabilities/document.js';
import { attachmentToolIds } from '../tools/attachment.js';
import { documentToolIds } from '../tools/document.js';

export async function documentIndexWorkflow(
  capabilityGateway: CapabilityGateway,
  documentStore: DocumentStore,
  params: {
    readonly attachmentId: string;
    readonly createdByTurnId: string;
    readonly signal?: AbortSignal;
  },
): Promise<DocumentBundle> {
  const { value } = await capabilityGateway.invoke(
    COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL,
    attachmentToolIds.read,
    { attachmentId: params.attachmentId },
    { signal: params.signal },
  );
  const bundle = await buildDocumentBundle({
    attachment: value.attachment,
    content: value.content,
    createdByTurnId: params.createdByTurnId,
  });

  return documentStore.save(bundle);
}

export interface DocumentSearchArtifacts {
  readonly query: string;
  readonly results: readonly DocumentSearchHit[];
}

export async function documentSearchWorkflow(
  capabilityGateway: CapabilityGateway,
  input: {
    readonly query: string;
    readonly documentId?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  },
): Promise<DocumentSearchArtifacts> {
  const { value: results } = await capabilityGateway.invoke(
    COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL,
    documentToolIds.search,
    {
      query: input.query,
      ...(input.documentId ? { documentId: input.documentId } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    },
    { signal: input.signal },
  );

  return { query: input.query, results };
}
