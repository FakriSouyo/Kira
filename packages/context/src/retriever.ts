import {
  ArtifactEnvelopeSchema,
  ArtifactRefSchema,
  ArtifactRetrievalQuerySchema,
  type ArtifactRetrievalQuery,
} from '@harness/schemas';
import type { ArtifactStore } from '@harness/session-core';
import {
  type ArtifactValidityResult,
  type ContextArtifactRole,
  type RetrievedArtifactCandidate,
} from './contracts.js';
import type { DurableArtifactRef } from '@harness/schemas';
import { evaluateArtifactValidity } from './validity.js';

export type ArtifactCandidate = RetrievedArtifactCandidate;

export interface ArtifactCandidateRetrievalResult {
  readonly query: ArtifactRetrievalQuery;
  readonly candidates: readonly ArtifactCandidate[];
  readonly diagnostics: readonly {
    readonly artifactId?: string;
    readonly kind?: string;
    readonly status: 'discovered' | 'skipped';
    readonly reason: string;
  }[];
}

function roleFor(kind: DurableArtifactRef['kind']): ContextArtifactRole {
  if (kind === 'BULL_CASE') return 'RETRIEVED_BULL_CASE';
  if (kind === 'BEAR_CASE') return 'RETRIEVED_BEAR_CASE';
  return 'RETRIEVED_VERDICT';
}

export async function retrieveArtifactCandidates(params: {
  artifactStore: Pick<ArtifactStore, 'listByQuery'> & Partial<Pick<ArtifactStore, 'getSourceExecution'>>;
  query: ArtifactRetrievalQuery;
  evaluate?: (artifact: RetrievedArtifactCandidate['artifact']) => Promise<ArtifactValidityResult> | ArtifactValidityResult;
}): Promise<ArtifactCandidateRetrievalResult> {
  const query = ArtifactRetrievalQuerySchema.parse(params.query);
  const values = await params.artifactStore.listByQuery(query);
  const seen = new Set<string>();
  const candidates: ArtifactCandidate[] = [];
  const diagnostics: Array<ArtifactCandidateRetrievalResult['diagnostics'][number]> = [];
  for (const value of values) {
    const parsed = ArtifactEnvelopeSchema.safeParse(value);
    if (!parsed.success) {
      diagnostics.push({ status: 'skipped', reason: 'MALFORMED_ARTIFACT' });
      continue;
    }
    if (parsed.data.sessionId !== query.sessionId) {
      diagnostics.push({ artifactId: parsed.data.artifactId, kind: parsed.data.kind, status: 'skipped', reason: 'WRONG_SESSION' });
      continue;
    }
    if (!query.subjects.includes(parsed.data.ticker)) {
      diagnostics.push({ artifactId: parsed.data.artifactId, kind: parsed.data.kind, status: 'skipped', reason: 'WRONG_SUBJECT' });
      continue;
    }
    if (!query.allowedKinds.includes(parsed.data.kind)) {
      diagnostics.push({ artifactId: parsed.data.artifactId, kind: parsed.data.kind, status: 'skipped', reason: 'WRONG_KIND' });
      continue;
    }
    if (seen.has(parsed.data.artifactId)) {
      diagnostics.push({ artifactId: parsed.data.artifactId, kind: parsed.data.kind, status: 'skipped', reason: 'DUPLICATE' });
      continue;
    }
    seen.add(parsed.data.artifactId);
    const sourceExecution = params.artifactStore.getSourceExecution
      ? await params.artifactStore.getSourceExecution(parsed.data.executionId)
      : undefined;
    const validity = await params.evaluate?.(parsed.data) ?? evaluateArtifactValidity({
      artifact: parsed.data,
      expectedSession: query.sessionId,
      expectedSubjects: query.subjects,
      expectedKind: parsed.data.kind,
      sourceExecution,
    });
    if (validity.status === 'INVALID') {
      diagnostics.push({ artifactId: parsed.data.artifactId, kind: parsed.data.kind, status: 'skipped', reason: validity.reasons.join('|') });
      continue;
    }
    const ref = ArtifactRefSchema.parse({ kind: parsed.data.kind, artifactId: parsed.data.artifactId });
    candidates.push({ ref, artifact: parsed.data, role: roleFor(parsed.data.kind), source: 'RETRIEVED', validity });
    diagnostics.push({ artifactId: parsed.data.artifactId, kind: parsed.data.kind, status: 'discovered', reason: validity.status });
  }
  const latest = new Set<string>();
  const selected: ArtifactCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.artifact.ticker}|${candidate.artifact.kind}`;
    if (latest.has(key)) {
      diagnostics.push({ artifactId: candidate.artifact.artifactId, kind: candidate.artifact.kind, status: 'skipped', reason: 'SUPERSEDED' });
      continue;
    }
    latest.add(key);
    selected.push(candidate);
  }
  return { query, candidates: selected, diagnostics };
}
