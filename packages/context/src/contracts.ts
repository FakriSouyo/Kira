import { z } from 'zod';
import {
  ArtifactEnvelopeSchema,
  ArtifactRefSchema,
  type ArtifactEnvelope,
  type DurableArtifactRef,
} from '@harness/schemas';
import type {
  ArtifactRef,
  AssumptionRef,
  EntityRef,
  FocusTopic,
  IntentRef,
  OpenQuestion,
  SessionWorkingContext,
  UserAssertionRef,
} from '@harness/session-core';

export const CONTEXT_PACKET_SCHEMA_VERSION = 1 as const;

export const ContextArtifactRoleSchema = z.enum([
  'ACTIVE_THESIS',
  'ACTIVE_BULL_CASE',
  'ACTIVE_BEAR_CASE',
  'ACTIVE_VERDICT',
  'PINNED_ARTIFACT',
]);
export type ContextArtifactRole = z.infer<typeof ContextArtifactRoleSchema>;

export const ContextCandidateSourceSchema = z.enum(['ACTIVE', 'PINNED']);
export type ContextCandidateSource = z.infer<typeof ContextCandidateSourceSchema>;

export const ContextDiagnosticStageSchema = z.enum(['resolver', 'policy', 'assembler']);
export type ContextDiagnosticStage = z.infer<typeof ContextDiagnosticStageSchema>;

export const ContextDiagnosticStatusSchema = z.enum(['discovered', 'resolved', 'selected', 'skipped', 'failed']);
export type ContextDiagnosticStatus = z.infer<typeof ContextDiagnosticStatusSchema>;

export const ContextDiagnosticCodeSchema = z.enum([
  'CANDIDATE',
  'RESOLVED',
  'SELECTED',
  'MALFORMED_REF',
  'LEGACY_REF',
  'MISSING_ARTIFACT',
  'TYPE_MISMATCH',
  'ROLE_KIND_MISMATCH',
  'CROSS_SESSION',
  'MALFORMED_ARTIFACT',
  'SUBJECT_MISMATCH',
  'UNSUPPORTED_ROLE',
  'NOT_RELEVANT',
  'DUPLICATE',
]);
export type ContextDiagnosticCode = z.infer<typeof ContextDiagnosticCodeSchema>;

const LegacyJudgmentRefSchema = z.object({ kind: z.literal('judgment'), executionId: z.string().min(1) }).strict();
const ContextSourceArtifactRefSchema = z.union([ArtifactRefSchema, LegacyJudgmentRefSchema]);
export const ContextSourceRefSchema = z.object({
  role: ContextArtifactRoleSchema,
  source: ContextCandidateSourceSchema,
  ref: ContextSourceArtifactRefSchema,
}).strict();
export type ContextSourceRef = z.infer<typeof ContextSourceRefSchema>;

export const ContextDiagnosticSchema = z.object({
  stage: ContextDiagnosticStageSchema,
  status: ContextDiagnosticStatusSchema,
  code: ContextDiagnosticCodeSchema,
  reason: z.string().min(1).optional(),
  role: ContextArtifactRoleSchema.optional(),
  source: ContextCandidateSourceSchema.optional(),
  ref: ContextSourceArtifactRefSchema.optional(),
  artifactId: z.string().min(1).optional(),
}).strict();
export type ContextDiagnostic = z.infer<typeof ContextDiagnosticSchema>;

export interface ResolvedContextCandidate {
  readonly ref: DurableArtifactRef;
  readonly artifact: ArtifactEnvelope;
  readonly role: ContextArtifactRole;
  readonly source: ContextCandidateSource;
}

export const ResolvedContextArtifactSchema = z.object({
  artifact: ArtifactEnvelopeSchema,
  roles: ContextArtifactRoleSchema.array().min(1),
  sourceRefs: ContextSourceRefSchema.array().min(1),
}).strict();
export type ResolvedContextArtifact = z.infer<typeof ResolvedContextArtifactSchema>;

const EntityRefSchema = z.object({ ticker: z.string().min(1) }).strict();
const IntentRefSchema = z.object({ command: z.string().min(1) }).strict();
const FocusTopicSchema = z.object({ topic: z.string().min(1) }).strict();
const OpenQuestionSchema = z.object({
  kind: z.literal('OPEN_QUESTION'), id: z.string().min(1), text: z.string(), turnId: z.string().min(1),
}).strict();
const UserAssertionSchema = z.object({
  kind: z.literal('USER_ASSERTION'), id: z.string().min(1), text: z.string(), turnId: z.string().min(1),
}).strict();
const AssumptionSchema = z.object({
  kind: z.literal('ASSUMPTION'), id: z.string().min(1), text: z.string(), turnId: z.string().min(1),
}).strict();

export const ContextPacketProvenanceSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  workingContextVersion: z.number().int().nonnegative(),
  sourceContextSequence: z.number().int().nonnegative(),
  sourceRefs: ContextSourceRefSchema.array(),
  selectedArtifactIds: z.string().min(1).array(),
  diagnostics: ContextDiagnosticSchema.array(),
}).strict();
export type ContextPacketProvenance = z.infer<typeof ContextPacketProvenanceSchema>;

export const ContextPacketSchema = z.object({
  schemaVersion: z.literal(CONTEXT_PACKET_SCHEMA_VERSION),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  activeSubjects: EntityRefSchema.array(),
  intent: IntentRefSchema.nullable(),
  focusTopics: FocusTopicSchema.array(),
  artifacts: ResolvedContextArtifactSchema.array(),
  userAssertions: UserAssertionSchema.array(),
  assumptions: AssumptionSchema.array(),
  unresolvedQuestions: OpenQuestionSchema.array(),
  provenance: ContextPacketProvenanceSchema,
}).strict();
type ContextPacketValue = z.infer<typeof ContextPacketSchema>;
type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? ReadonlyArray<DeepReadonly<Item>>
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;
export type ContextPacket = DeepReadonly<ContextPacketValue>;

export type ContextFocus = 'generic' | 'downside' | 'thesis' | 'bull' | 'bear';

export interface ContextPolicyInput {
  readonly focus?: ContextFocus;
}

export interface ContextResolutionResult {
  readonly candidates: readonly ResolvedContextCandidate[];
  readonly sourceRefs: readonly ContextSourceRef[];
  readonly diagnostics: readonly ContextDiagnostic[];
}

export interface ContextPolicyResult {
  readonly selected: readonly ResolvedContextCandidate[];
  readonly diagnostics: readonly ContextDiagnostic[];
}

export interface ContextAssemblyResult {
  readonly packet: ContextPacket;
  readonly diagnostics: readonly ContextDiagnostic[];
}

export type ContextIntegrityCode =
  | 'MALFORMED_REF'
  | 'MISSING_ARTIFACT'
  | 'TYPE_MISMATCH'
  | 'ROLE_KIND_MISMATCH'
  | 'CROSS_SESSION'
  | 'MALFORMED_ARTIFACT'
  | 'SUBJECT_MISMATCH'
  | 'UNSUPPORTED_ROLE';

export class ContextIntegrityError extends Error {
  readonly name = 'ContextIntegrityError';

  constructor(
    readonly code: ContextIntegrityCode,
    message: string,
    readonly role?: ContextArtifactRole,
    readonly source?: ContextCandidateSource,
    readonly ref?: ArtifactRef,
  ) {
    super(message);
  }
}

export interface AssembleContextParams {
  readonly sessionId: string;
  readonly turnId: string;
  readonly workingContext: SessionWorkingContext;
  readonly selectedCandidates: readonly ResolvedContextCandidate[];
  readonly sourceRefs: readonly ContextSourceRef[];
  readonly diagnostics?: readonly ContextDiagnostic[];
  readonly intent?: IntentRef | null;
}

export interface ResolveContextParams {
  readonly sessionId: string;
  readonly workingContext: SessionWorkingContext;
  readonly artifactStore: {
    resolve(ref: DurableArtifactRef): Promise<ArtifactEnvelope | null>;
    getById(artifactId: string): Promise<ArtifactEnvelope | null>;
  };
}

export interface SelectContextParams {
  readonly candidates: readonly ResolvedContextCandidate[];
  readonly intent?: ContextPolicyInput;
}

export type ContextWorkingState = Pick<SessionWorkingContext,
  'activeSubjects' | 'currentIntent' | 'focusTopics' | 'userAssertions' | 'assumptions' | 'unresolvedQuestions'>;

export type { ArtifactEnvelope, ArtifactRef, AssumptionRef, EntityRef, FocusTopic, IntentRef, OpenQuestion, SessionWorkingContext, UserAssertionRef };
