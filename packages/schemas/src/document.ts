import { z } from 'zod';

export const DOCUMENT_SCHEMA_VERSION = 1 as const;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nullableNonNegativeInteger = z.number().int().nonnegative().nullable();

export const DocumentMediaTypeSchema = z.enum([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'text/csv',
  'text/tab-separated-values',
]);

export const DocumentSchema = z.object({
  documentId: z.string().min(1),
  schemaVersion: z.literal(DOCUMENT_SCHEMA_VERSION),
  sessionId: z.string().min(1),
  attachmentId: z.string().min(1),
  sourceContentHash: hashSchema,
  filename: z.string().min(1),
  detectedMediaType: DocumentMediaTypeSchema,
  extractorId: z.string().min(1),
  extractorVersion: z.string().min(1),
  textHash: hashSchema,
  pageCount: nullableNonNegativeInteger,
  chunkCount: z.number().int().nonnegative(),
  createdByTurnId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const DocumentChunkSchema = z.object({
  chunkId: z.string().min(1),
  schemaVersion: z.literal(DOCUMENT_SCHEMA_VERSION),
  documentId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  text: z.string().min(1),
  contentHash: hashSchema,
  pageStart: nullableNonNegativeInteger,
  pageEnd: nullableNonNegativeInteger,
  lineStart: nullableNonNegativeInteger,
  lineEnd: nullableNonNegativeInteger,
  section: z.string().min(1).nullable(),
}).strict();

export const DocumentCitationSchema = z.object({
  attachmentId: z.string().min(1),
  documentId: z.string().min(1),
  chunkId: z.string().min(1),
  filename: z.string().min(1),
  sourceContentHash: hashSchema,
  contentHash: hashSchema,
  pageStart: nullableNonNegativeInteger,
  pageEnd: nullableNonNegativeInteger,
  lineStart: nullableNonNegativeInteger,
  lineEnd: nullableNonNegativeInteger,
  section: z.string().min(1).nullable(),
}).strict();

export const DocumentSearchQuerySchema = z.object({
  query: z.string().min(1),
  documentId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict();

export const DocumentSearchHitSchema = z.object({
  score: z.number().finite(),
  text: z.string().min(1),
  chunk: DocumentChunkSchema,
  citation: DocumentCitationSchema,
}).strict();

export type Document = z.infer<typeof DocumentSchema>;
export type DocumentChunk = z.infer<typeof DocumentChunkSchema>;
export type DocumentCitation = z.infer<typeof DocumentCitationSchema>;
export type DocumentSearchQuery = z.infer<typeof DocumentSearchQuerySchema>;
export type DocumentSearchHit = z.infer<typeof DocumentSearchHitSchema>;
