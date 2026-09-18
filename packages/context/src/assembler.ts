import { ArtifactEnvelopeSchema } from '@harness/schemas';
import {
  ContextIntegrityError,
  ContextPacketSchema,
  ResolvedContextArtifactSchema,
  type AssembleContextParams,
  type ContextArtifactRole,
  type ContextAssemblyResult,
  type ContextDiagnostic,
  type ContextPacket,
  type ContextSourceRef,
  type ResolvedContextArtifact,
} from './contracts.js';

const ROLE_ORDER: readonly ContextArtifactRole[] = [
  'ACTIVE_THESIS',
  'ACTIVE_BULL_CASE',
  'ACTIVE_BEAR_CASE',
  'ACTIVE_VERDICT',
  'PINNED_ARTIFACT',
  'RETRIEVED_BULL_CASE',
  'RETRIEVED_BEAR_CASE',
  'RETRIEVED_VERDICT',
];

function roleRank(role: ContextArtifactRole): number {
  return ROLE_ORDER.indexOf(role);
}

function sourceRank(source: ContextSourceRef['source']): number {
  return source === 'ACTIVE' ? 0 : source === 'PINNED' ? 1 : 2;
}

function sourceRefKey(value: ContextSourceRef): string {
  return `${value.role}|${value.source}|${value.ref.kind}|${value.ref.kind === 'judgment' ? value.ref.executionId : value.ref.artifactId}`;
}

function refKey(value: ContextSourceRef['ref']): string {
  return value.kind === 'judgment' ? `judgment|${value.executionId}` : `${value.kind}|${value.artifactId}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function diagnosticOrder(left: ContextDiagnostic, right: ContextDiagnostic): number {
  const stage = left.stage.localeCompare(right.stage);
  if (stage !== 0) return stage;
  const role = (left.role ? roleRank(left.role) : 99) - (right.role ? roleRank(right.role) : 99);
  if (role !== 0) return role;
  const artifact = (left.artifactId ?? '').localeCompare(right.artifactId ?? '');
  if (artifact !== 0) return artifact;
  return left.code.localeCompare(right.code);
}

/** Assembles a read-only invocation projection without persistence or execution side effects. */
export function assembleContext(params: AssembleContextParams): ContextAssemblyResult {
  if (params.sessionId !== params.workingContext.sessionId) {
    throw new ContextIntegrityError('CROSS_SESSION', `Working context belongs to session ${params.workingContext.sessionId}`);
  }

  const groups = new Map<string, {
    artifact: ReturnType<typeof ArtifactEnvelopeSchema.parse>;
    roles: Set<ContextArtifactRole>;
    sourceRefs: Map<string, ContextSourceRef>;
  }>();

  for (const candidate of params.selectedCandidates) {
    if (candidate.artifact.sessionId !== params.sessionId) {
      throw new ContextIntegrityError('CROSS_SESSION', `Artifact ${candidate.artifact.artifactId} belongs to another session`, candidate.role, candidate.source, candidate.ref);
    }
    if (candidate.ref.kind !== candidate.artifact.kind) {
      throw new ContextIntegrityError('TYPE_MISMATCH', `Artifact ${candidate.artifact.artifactId} does not match its ref`, candidate.role, candidate.source, candidate.ref);
    }
    const parsed = ArtifactEnvelopeSchema.safeParse(candidate.artifact);
    if (!parsed.success) {
      throw new ContextIntegrityError('MALFORMED_ARTIFACT', `Artifact ${candidate.ref.artifactId} failed schema validation`, candidate.role, candidate.source, candidate.ref);
    }
    const group = groups.get(candidate.artifact.artifactId) ?? {
      artifact: parsed.data,
      roles: new Set<ContextArtifactRole>(),
      sourceRefs: new Map<string, ContextSourceRef>(),
    };
    group.roles.add(candidate.role);
    const source: ContextSourceRef = { role: candidate.role, source: candidate.source, ref: candidate.ref };
    group.sourceRefs.set(sourceRefKey(source), source);
    groups.set(candidate.artifact.artifactId, group);
  }

  const artifacts: ResolvedContextArtifact[] = [...groups.values()]
    .sort((left, right) => {
      const leftRole = Math.min(...[...left.roles].map(roleRank));
      const rightRole = Math.min(...[...right.roles].map(roleRank));
      if (leftRole !== rightRole) return leftRole - rightRole;
      return left.artifact.artifactId.localeCompare(right.artifact.artifactId);
    })
    .map(group => ResolvedContextArtifactSchema.parse({
      artifact: group.artifact,
      roles: [...group.roles].sort((left, right) => roleRank(left) - roleRank(right)),
      sourceRefs: [...group.sourceRefs.values()].sort((left, right) => {
        const role = roleRank(left.role) - roleRank(right.role);
        if (role !== 0) return role;
        return sourceRank(left.source) - sourceRank(right.source);
      }),
      reuseStatus: [...group.sourceRefs.values()].some(source => source.source === 'RETRIEVED') ? 'PRIOR' : undefined,
    }));

  const diagnostics = [...(params.diagnostics ?? [])].sort(diagnosticOrder);
  const sourceRefs = [...params.sourceRefs].sort((left, right) => {
    const role = roleRank(left.role) - roleRank(right.role);
    if (role !== 0) return role;
    const source = sourceRank(left.source) - sourceRank(right.source);
    if (source !== 0) return source;
    return refKey(left.ref).localeCompare(refKey(right.ref));
  });
  const packetDraft = {
    schemaVersion: 1 as const,
    sessionId: params.sessionId,
    turnId: params.turnId,
    activeSubjects: params.workingContext.activeSubjects,
    intent: params.intent === undefined ? params.workingContext.currentIntent : params.intent,
    focusTopics: params.workingContext.focusTopics,
    artifacts,
    userAssertions: params.workingContext.userAssertions,
    assumptions: params.workingContext.assumptions,
    unresolvedQuestions: params.workingContext.unresolvedQuestions,
    provenance: {
      sessionId: params.sessionId,
      turnId: params.turnId,
      workingContextVersion: params.workingContext.version,
      sourceContextSequence: params.workingContext.sourceSequence,
      sourceRefs,
      selectedArtifactIds: artifacts.map(item => item.artifact.artifactId),
      diagnostics,
    },
  };
  const packet = deepFreeze(ContextPacketSchema.parse(packetDraft)) as ContextPacket;
  const frozenDiagnostics = deepFreeze(structuredClone(diagnostics));
  return { packet, diagnostics: frozenDiagnostics };
}
