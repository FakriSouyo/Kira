import { z } from 'zod';
import { DocumentSearchHitSchema, DocumentSearchQuerySchema } from '@harness/schemas';
import { DocumentError, compareDocumentSearchHits, searchDocumentChunks, type DocumentStore } from '@harness/document';
import { defineTool } from '@harness/tool-runtime';

export const documentToolIds = {
  search: 'document.search',
} as const;

export interface DocumentToolOptions {
  readonly documentStore: DocumentStore;
  readonly sessionId: string;
}

export function createDocumentTools({ documentStore, sessionId }: DocumentToolOptions) {
  if (!sessionId.trim()) throw new Error('Document tools require a trusted active sessionId');

  const search = defineTool({
    id: documentToolIds.search,
    inputSchema: DocumentSearchQuerySchema,
    outputSchema: z.array(DocumentSearchHitSchema),
    execute: async (input) => {
      if (input.documentId) {
        const bundle = await documentStore.getById(input.documentId);
        if (!bundle || bundle.document.sessionId !== sessionId) {
          throw new DocumentError('DOCUMENT_NOT_FOUND', `Document ${input.documentId} was not found`);
        }
        return searchDocumentChunks(bundle.document, bundle.chunks, input);
      }
      const bundles = await documentStore.listBySession(sessionId);
      return bundles
        .flatMap(bundle => searchDocumentChunks(bundle.document, bundle.chunks, input))
        .sort(compareDocumentSearchHits)
        .slice(0, input.limit ?? 20);
    },
  });

  return Object.freeze({ search });
}

export type DocumentTools = ReturnType<typeof createDocumentTools>;
