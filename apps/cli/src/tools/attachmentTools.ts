import { z } from 'zod';
import { AttachmentSchema, type Attachment } from '@harness/schemas';
import { AttachmentStoreError, type AttachmentStore } from '@harness/session-core';
import { defineTool } from '@harness/tool-runtime';

export const attachmentToolIds = {
  list: 'workspace.list-attachments',
  describe: 'attachment.describe',
  read: 'attachment.read',
} as const;

const emptyInputSchema = z.object({}).strict();
const attachmentIdInputSchema = z.object({ attachmentId: z.string().min(1) }).strict();
const readOutputSchema = z.object({
  attachment: AttachmentSchema,
  content: z.instanceof(Uint8Array),
}).strict();

function notFound(attachmentId: string): AttachmentStoreError {
  return new AttachmentStoreError('ATTACHMENT_NOT_FOUND', `Attachment ${attachmentId} not found`);
}

export interface AttachmentToolOptions {
  readonly attachmentStore: AttachmentStore;
  readonly sessionId: string;
}

export function createAttachmentTools({ attachmentStore, sessionId }: AttachmentToolOptions) {
  if (!sessionId.trim()) throw new Error('Attachment tools require a trusted active sessionId');

  const resolveOwned = async (attachmentId: string): Promise<Attachment> => {
    const attachment = await attachmentStore.getById(attachmentId);
    if (!attachment || attachment.sessionId !== sessionId) throw notFound(attachmentId);
    return attachment;
  };

  const list = defineTool({
    id: attachmentToolIds.list,
    inputSchema: emptyInputSchema,
    outputSchema: AttachmentSchema.array(),
    execute: async () => attachmentStore.listBySession(sessionId),
  });

  const describe = defineTool({
    id: attachmentToolIds.describe,
    inputSchema: attachmentIdInputSchema,
    outputSchema: AttachmentSchema,
    execute: async ({ attachmentId }) => resolveOwned(attachmentId),
  });

  const read = defineTool({
    id: attachmentToolIds.read,
    inputSchema: attachmentIdInputSchema,
    outputSchema: readOutputSchema,
    execute: async ({ attachmentId }) => {
      const attachment = await resolveOwned(attachmentId);
      const content = await attachmentStore.readContent(attachment.attachmentId);
      return { attachment, content };
    },
  });

  return Object.freeze({ list, describe, read });
}

export type AttachmentTools = ReturnType<typeof createAttachmentTools>;
