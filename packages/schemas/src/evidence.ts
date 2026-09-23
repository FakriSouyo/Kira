import { z } from 'zod';

/** Baris tabel evidence (addendum §07/§11). */
export const EvidenceSchema = z.object({
  id: z.string().uuid(),
  runId: z.string(),
  ticker: z.string(),
  source: z.string(),
  sourceType: z.enum(['api', 'manual', 'cached', 'mock', 'derived', 'document']),
  contentHash: z.string(),
  retrievedAt: z.string(),
  validAt: z.string().nullable().optional(),
  data: z.record(z.unknown()),
  provenance: z.record(z.unknown()).nullable().optional(),
  acceptance: z.object({
    policyId: z.string(), policyFingerprint: z.string().nullable(), candidateKind: z.enum(['financial', 'document', 'legacy']),
    sourceOrigin: z.string().nullable(), retrievedAt: z.string().nullable(),
    acceptedAt: z.string().nullable(), validAt: z.string().nullable(),
    provenance: z.record(z.unknown()), legacy: z.boolean().optional(),
  }).optional(),
  createdAt: z.string().optional(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
