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
];

const roleRank = (role: ContextArtifactRole): number => ROLE_ORDER.indexOf(role);

function selectedForFocus(candidate: ResolvedContextCandidate, focus: ContextFocus): boolean {
  if (candidate.source === 'PINNED') return true;
  if (focus === 'generic') return true;
  if (focus === 'downside' || focus === 'bear') return candidate.role === 'ACTIVE_BEAR_CASE' || candidate.role === 'ACTIVE_VERDICT';
  if (focus === 'thesis' || focus === 'bull') return candidate.role === 'ACTIVE_THESIS' || candidate.role === 'ACTIVE_BULL_CASE';
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
  return (left.source === 'ACTIVE' ? 0 : 1) - (right.source === 'ACTIVE' ? 0 : 1);
}

/** Selects explicit resolved candidates using only structured deterministic focus. */
export function selectContextCandidates(params: SelectContextParams): ContextPolicyResult {
  const focus = params.intent?.focus ?? 'generic';
  const selected: ResolvedContextCandidate[] = [];
  const diagnostics: ContextDiagnostic[] = [];
  for (const candidate of params.candidates) {
    if (selectedForFocus(candidate, focus)) {
      selected.push(candidate);
      diagnostics.push(diagnostic(candidate, 'selected', 'SELECTED'));
    } else {
      diagnostics.push(diagnostic(candidate, 'skipped', 'NOT_RELEVANT'));
    }
  }
  selected.sort(compareCandidates);
  return { selected, diagnostics };
}

export type { ContextPolicyInput };
