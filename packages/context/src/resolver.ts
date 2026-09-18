import {
  ArtifactEnvelopeSchema,
  ArtifactRefSchema,
  type ArtifactEnvelope,
  type DurableArtifactRef,
} from '@harness/schemas';
import type { ArtifactRef, SessionWorkingContext } from '@harness/session-core';
import {
  ContextIntegrityError,
  type ContextArtifactRole,
  type ContextCandidateSource,
  type ContextDiagnostic,
  type ContextResolutionResult,
  type ContextSourceRef,
  type ResolveContextParams,
  type ResolvedContextCandidate,
} from './contracts.js';

type ActiveSlot = {
  readonly key: 'activeThesisRef' | 'activeVerdictRef' | 'activeBullCaseRef' | 'activeBearCaseRef';
  readonly role: ContextArtifactRole;
  readonly expectedKind: DurableArtifactRef['kind'];
};

const ACTIVE_SLOTS: readonly ActiveSlot[] = [
  { key: 'activeThesisRef', role: 'ACTIVE_THESIS', expectedKind: 'BULL_CASE' },
  { key: 'activeBullCaseRef', role: 'ACTIVE_BULL_CASE', expectedKind: 'BULL_CASE' },
  { key: 'activeBearCaseRef', role: 'ACTIVE_BEAR_CASE', expectedKind: 'BEAR_CASE' },
  { key: 'activeVerdictRef', role: 'ACTIVE_VERDICT', expectedKind: 'VERDICT' },
];

function legacyRef(value: unknown): value is { kind: 'judgment'; executionId: string } {
  return typeof value === 'object' && value !== null
    && (value as { kind?: unknown }).kind === 'judgment'
    && typeof (value as { executionId?: unknown }).executionId === 'string'
    && (value as { executionId: string }).executionId.length > 0;
}

function diagnostic(params: Omit<ContextDiagnostic, 'stage'>): ContextDiagnostic {
  return { stage: 'resolver', ...params };
}

function sourceRef(role: ContextArtifactRole, source: ContextCandidateSource, ref: ArtifactRef): ContextSourceRef {
  return { role, source, ref };
}

function integrity(
  code: ConstructorParameters<typeof ContextIntegrityError>[0],
  message: string,
  role: ContextArtifactRole,
  source: ContextCandidateSource,
  ref?: ArtifactRef,
): ContextIntegrityError {
  return new ContextIntegrityError(code, message, role, source, ref);
}

function activeArtifactMatchesSubject(artifact: ArtifactEnvelope, workingContext: SessionWorkingContext): boolean {
  return workingContext.activeSubjects.length === 0
    || workingContext.activeSubjects.some(subject => subject.ticker === artifact.ticker);
}

async function resolveOne(
  params: ResolveContextParams,
  rawRef: unknown,
  role: ContextArtifactRole,
  source: ContextCandidateSource,
  expectedKind: DurableArtifactRef['kind'] | null | undefined,
  required: boolean,
  candidates: ResolvedContextCandidate[],
  sourceRefs: ContextSourceRef[],
  diagnostics: ContextDiagnostic[],
): Promise<void> {
  if (rawRef === null || rawRef === undefined) return;

  if (legacyRef(rawRef)) {
    const legacy = rawRef as ArtifactRef;
    sourceRefs.push(sourceRef(role, source, legacy));
    diagnostics.push(diagnostic({
      status: 'skipped', code: 'LEGACY_REF', reason: 'legacy-ref-unresolved', role, source, ref: legacy,
    }));
    return;
  }

  const parsed = ArtifactRefSchema.safeParse(rawRef);
  if (!parsed.success) {
    throw integrity('MALFORMED_REF', `${role} reference is malformed`, role, source);
  }
  const ref = parsed.data;
  sourceRefs.push(sourceRef(role, source, ref));
  diagnostics.push(diagnostic({ status: 'discovered', code: 'CANDIDATE', role, source, ref }));

  if (expectedKind === null) {
    throw integrity('UNSUPPORTED_ROLE', `${role} has no supported PR F artifact kind`, role, source, ref);
  }
  if (expectedKind !== undefined && ref.kind !== expectedKind) {
    throw integrity('ROLE_KIND_MISMATCH', `${role} requires ${expectedKind}, received ${ref.kind}`, role, source, ref);
  }

  let artifact = await params.artifactStore.resolve(ref);
  if (!artifact) {
    const stored = await params.artifactStore.getById(ref.artifactId);
    if (!stored) {
      const error = integrity('MISSING_ARTIFACT', `Artifact ${ref.artifactId} was not found`, role, source, ref);
      if (required) throw error;
      diagnostics.push(diagnostic({ status: 'failed', code: 'MISSING_ARTIFACT', reason: 'missing', role, source, ref, artifactId: ref.artifactId }));
      return;
    }
    throw integrity('TYPE_MISMATCH', `Artifact ${ref.artifactId} is ${stored.kind}, not ${ref.kind}`, role, source, ref);
  }

  const validated = ArtifactEnvelopeSchema.safeParse(artifact);
  if (!validated.success) {
    throw integrity('MALFORMED_ARTIFACT', `Artifact ${ref.artifactId} failed schema validation`, role, source, ref);
  }
  artifact = validated.data;
  if (artifact.kind !== ref.kind) {
    throw integrity('TYPE_MISMATCH', `Artifact ${ref.artifactId} is ${artifact.kind}, not ${ref.kind}`, role, source, ref);
  }
  if (artifact.sessionId !== params.sessionId) {
    throw integrity('CROSS_SESSION', `Artifact ${ref.artifactId} belongs to session ${artifact.sessionId}`, role, source, ref);
  }
  if (source === 'ACTIVE' && !activeArtifactMatchesSubject(artifact, params.workingContext)) {
    throw integrity('SUBJECT_MISMATCH', `Active artifact ${ref.artifactId} does not match the active subject set`, role, source, ref);
  }

  candidates.push({ ref, artifact, role, source });
  diagnostics.push(diagnostic({ status: 'resolved', code: 'RESOLVED', role, source, ref, artifactId: artifact.artifactId }));
}

/** Resolves only explicit references in the captured SessionWorkingContext. */
export async function resolveContextCandidates(params: ResolveContextParams): Promise<ContextResolutionResult> {
  const candidates: ResolvedContextCandidate[] = [];
  const sourceRefs: ContextSourceRef[] = [];
  const diagnostics: ContextDiagnostic[] = [];

  for (const slot of ACTIVE_SLOTS) {
    await resolveOne(
      params,
      params.workingContext[slot.key],
      slot.role,
      'ACTIVE',
      slot.expectedKind,
      slot.key === 'activeVerdictRef',
      candidates,
      sourceRefs,
      diagnostics,
    );
  }

  await resolveOne(
    params,
    params.workingContext.activeRiskAssessmentRef,
    'ACTIVE_VERDICT',
    'ACTIVE',
    null,
    false,
    candidates,
    sourceRefs,
    diagnostics,
  );
  await resolveOne(
    params,
    params.workingContext.runningSummaryRef,
    'ACTIVE_VERDICT',
    'ACTIVE',
    null,
    false,
    candidates,
    sourceRefs,
    diagnostics,
  );

  for (const ref of params.workingContext.pinnedArtifactRefs) {
    await resolveOne(params, ref, 'PINNED_ARTIFACT', 'PINNED', undefined, false, candidates, sourceRefs, diagnostics);
  }

  return { candidates, sourceRefs, diagnostics };
}
