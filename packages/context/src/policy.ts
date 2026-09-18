import {
  type ContextArtifactRole,
  type ContextDiagnostic,
  type ContextPolicyResult,
  type ContextFocus,
  type ContextPolicyInput,
  type ResolvedContextCandidate,
  type SelectContextParams,
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

const roleRank = (role: ContextArtifactRole): number => ROLE_ORDER.indexOf(role);

function selectedForFocus(candidate: ResolvedContextCandidate, focus: ContextFocus, subjects?: readonly string[]): boolean {
  if (subjects && subjects.length > 0 && !subjects.includes(candidate.artifact.ticker)) return false;
  if (candidate.source === 'PINNED') return true;
  if (focus === 'generic') return true;
  if (focus === 'downside' || focus === 'bear') return candidate.role === 'ACTIVE_BEAR_CASE' || candidate.role === 'ACTIVE_VERDICT' || candidate.role === 'RETRIEVED_BEAR_CASE' || candidate.role === 'RETRIEVED_VERDICT';
  if (focus === 'thesis' || focus === 'bull') return candidate.role === 'ACTIVE_THESIS' || candidate.role === 'ACTIVE_BULL_CASE' || candidate.role === 'RETRIEVED_BULL_CASE';
  return false;
}

function diagnostic(candidate: ResolvedContextCandidate, status: ContextDiagnostic['status'], code: 'NOT_RELEVANT' | 'SELECTED'): ContextDiagnostic {
  return {
    stage: 'policy', status, code,
    reason: code === 'NOT_RELEVANT' ? 'not-relevant-to-intent' : 'eligible-for-intent',
    role: candidate.role, source: candidate.source, ref: candidate.ref, artifactId: candidate.artifact.artifactId,
  };
}

function compareCandidates(left: ResolvedContextCandidate, right: ResolvedContextCandidate): number {
  const roleDifference = roleRank(left.role) - roleRank(right.role);
  if (roleDifference !== 0) return roleDifference;
  const artifactDifference = left.artifact.artifactId.localeCompare(right.artifact.artifactId);
  if (artifactDifference !== 0) return artifactDifference;
  const sourceRank = (source: ResolvedContextCandidate['source']): number => source === 'ACTIVE' ? 0 : source === 'PINNED' ? 1 : 2;
  return sourceRank(left.source) - sourceRank(right.source);
}

/** Selects explicit resolved candidates using only structured deterministic focus. */
export function selectContextCandidates(params: SelectContextParams): ContextPolicyResult {
  const focus = params.intent?.focus ?? 'generic';
  const subjects = params.intent?.subjects;
  const explicitKeys = new Set(params.candidates
    .filter(candidate => candidate.source !== 'RETRIEVED')
    .map(candidate => `${candidate.artifact.ticker}|${candidate.artifact.kind}`));
  const selected: ResolvedContextCandidate[] = [];
  const diagnostics: ContextDiagnostic[] = [];
  for (const candidate of params.candidates) {
    const supersededByExplicit = candidate.source === 'RETRIEVED'
      && explicitKeys.has(`${candidate.artifact.ticker}|${candidate.artifact.kind}`);
    if (!supersededByExplicit && selectedForFocus(candidate, focus, subjects)) {
      selected.push(candidate);
      diagnostics.push(diagnostic(candidate, 'selected', 'SELECTED'));
    } else {
      diagnostics.push({ ...diagnostic(candidate, 'skipped', 'NOT_RELEVANT'), reason: supersededByExplicit ? 'superseded-by-explicit-ref' : 'not-relevant-to-intent' });
    }
  }
  selected.sort(compareCandidates);
  return { selected, diagnostics };
}

export type { ContextPolicyInput };
