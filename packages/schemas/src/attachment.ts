import { z } from 'zod';

export const ATTACHMENT_SCHEMA_VERSION = 1 as const;

export const AttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  schemaVersion: z.literal(ATTACHMENT_SCHEMA_VERSION),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  filename: z.string().min(1),
  mediaType: z.string().min(1).nullable(),
  sizeBytes: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export type Attachment = z.infer<typeof AttachmentSchema>;
