import { z } from 'zod';

/** Baris tabel evidence (addendum §07/§11). */
export const EvidenceSchema = z.object({
  id: z.string().uuid(),
  runId: z.string(),
  ticker: z.string(),
  source: z.string(),
  sourceType: z.enum(['api', 'manual', 'cached']),
  contentHash: z.string(),
  retrievedAt: z.string(),
  validAt: z.string().nullable().optional(),
  data: z.record(z.unknown()),
  provenance: z.record(z.unknown()).nullable().optional(),
  createdAt: z.string().optional(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
