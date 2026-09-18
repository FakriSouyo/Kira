import { z } from 'zod';
import {
  BearCounterpointSchema,
  ClaimSchema,
  EvidenceSchema,
  type BearCounterpoint,
  type Claim,
} from '@harness/schemas';

export const SPECIALIST_CONTEXT_SCHEMA_VERSION = 1 as const;

export const SpecialistRoleSchema = z.enum(['BULL', 'BEAR', 'JUDGE']);
export type SpecialistRole = z.infer<typeof SpecialistRoleSchema>;

export const SpecialistPhaseSchema = z.enum([
  'THESIS',
  'CHALLENGE',
  'REBUTTAL',
  'RECHALLENGE',
  'EVALUATION',
  'RESOLUTION',
]);
export type SpecialistPhase = z.infer<typeof SpecialistPhaseSchema>;

export const SpecialistDiscussionEntrySchema = z.object({
  agent: z.string().min(1),
  type: z.string().min(1),
  content: z.string().min(1),
}).strict();
export type SpecialistDiscussionEntry = z.infer<typeof SpecialistDiscussionEntrySchema>;

export const SpecialistSubjectSchema = z.object({ ticker: z.string().min(1) }).strict();
const SpecialistEvidenceSchema = EvidenceSchema.extend({ data: z.unknown() });
export type SpecialistEvidence = z.infer<typeof SpecialistEvidenceSchema>;

export const SpecialistContextPayloadSchema = z.object({
  schemaVersion: z.literal(SPECIALIST_CONTEXT_SCHEMA_VERSION),
  contextKind: z.literal('SPECIALIST'),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  executionId: z.string().min(1),
  subject: SpecialistSubjectSchema,
  role: SpecialistRoleSchema,
  phase: SpecialistPhaseSchema,
  roundNumber: z.number().int().positive(),
  evidence: SpecialistEvidenceSchema.array().min(1),
  evidenceIds: z.string().uuid().array().min(1),
  bullClaims: ClaimSchema.array().optional(),
  bearCounterpoints: BearCounterpointSchema.array().optional(),
  rebuttalClaims: ClaimSchema.array().optional(),
  discussion: SpecialistDiscussionEntrySchema.array().optional(),
  availableCategories: z.object({
    marketMomentum: z.boolean(),
    risk: z.boolean(),
  }).strict().optional(),
}).strict();
export type SpecialistContextPayload = z.infer<typeof SpecialistContextPayloadSchema>;

export type SpecialistClaim = Claim;
export type SpecialistCounterpoint = BearCounterpoint;
