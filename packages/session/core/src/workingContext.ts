import { canonicalJson } from '@harness/shared';
import type { DurableArtifactRef } from '@harness/schemas';

/**
 * SessionWorkingContext — PR D (Core Refactor Plan Phase 3).
 *
 * Materialized, versioned, durable view of *what remains relevant in one
 * session*. It is structured reference state, never history: the
 * ConversationJournal owns what happened and in what order, while this contract
 * owns only what is still relevant.
 *
 * Deliberately absent from this contract:
 * - conversation history or model prose (the journal is authoritative);
 * - provider freshness/cache decisions (PR E owns whether external data may be
 *   reused; a working context may reference something, it never authorizes it);
 * - LLM-visible packets or prompt text (Context Engine, PR G and later).
 */

/** Minimal entity identity available today: an IDX ticker. */
export interface EntityRef {
  ticker: string;
}

/** Intent of the settled Turn that produced the current version. */
export interface IntentRef {
  command: string;
}

/** Topic that remains in focus. No durable producer exists yet; PR F/G populate it. */
export interface FocusTopic {
  topic: string;
}

/**
 * Legacy durable reference retained for pre-PR-F rows. New work uses the typed
 * artifact refs from @harness/schemas.
 */
export interface JudgmentRef {
  kind: 'judgment';
  executionId: string;
}

/** Reference union. PR F adds the immutable typed-artifact kinds. */
export type ArtifactRef = JudgmentRef | DurableArtifactRef;

/** Open question attached to its originating Turn. */
export interface OpenQuestion {
  kind: 'OPEN_QUESTION';
  id: string;
  text: string;
  turnId: string;
}

/**
 * A user's own claim. Provenance stays explicit: a user assertion is never
 * verified evidence, and evidence truth remains owned by the financial
 * evidence subsystem.
 */
export interface UserAssertionRef {
  kind: 'USER_ASSERTION';
  id: string;
  text: string;
  turnId: string;
}

/** An assumption carried forward. Same provenance rule as user assertions. */
export interface AssumptionRef {
  kind: 'ASSUMPTION';
  id: string;
  text: string;
  turnId: string;
}

/** Provenance labels carried by working-context items. */
export type WorkingContextItemKind =
  | 'ACTIVE_ENTITY'
  | 'ACTIVE_INTENT'
  | 'ARTIFACT_REF'
  | 'OPEN_QUESTION'
  | 'USER_ASSERTION'
  | 'ASSUMPTION';

export interface SessionWorkingContext {
  sessionId: string;
  /** Monotonically increasing per session; 0 means "no committed version". */
  version: number;
  /** Highest ConversationJournal sequence observed when this version was derived. */
  sourceSequence: number;
  activeSubjects: EntityRef[];
  currentIntent: IntentRef | null;
  focusTopics: FocusTopic[];
  activeThesisRef: ArtifactRef | null;
  activeVerdictRef: ArtifactRef | null;
  activeBullCaseRef: ArtifactRef | null;
  activeBearCaseRef: ArtifactRef | null;
  activeRiskAssessmentRef: ArtifactRef | null;
  pinnedArtifactRefs: ArtifactRef[];
  unresolvedQuestions: OpenQuestion[];
  userAssertions: UserAssertionRef[];
  assumptions: AssumptionRef[];
  runningSummaryRef: ArtifactRef | null;
  /** Null only for the uncommitted default produced by `defaultWorkingContext`. */
  updatedByTurnId: string | null;
  updatedAt: string | null;
}

/** Fields a settled Turn may publish. Omitted fields keep their current value. */
export type WorkingContextPatch = Partial<Pick<SessionWorkingContext,
  | 'activeSubjects' | 'currentIntent' | 'focusTopics'
  | 'activeThesisRef' | 'activeVerdictRef' | 'activeBullCaseRef' | 'activeBearCaseRef' | 'activeRiskAssessmentRef'
  | 'pinnedArtifactRefs' | 'unresolvedQuestions' | 'userAssertions' | 'assumptions' | 'runningSummaryRef'>>;

/** Stable ordering keeps patches and persisted payloads byte-comparable. */
export const WORKING_CONTEXT_PATCH_FIELDS = [
  'activeSubjects', 'currentIntent', 'focusTopics',
  'activeThesisRef', 'activeVerdictRef', 'activeBullCaseRef', 'activeBearCaseRef', 'activeRiskAssessmentRef',
  'pinnedArtifactRefs', 'unresolvedQuestions', 'userAssertions', 'assumptions', 'runningSummaryRef',
] as const satisfies ReadonlyArray<keyof WorkingContextPatch>;

/** Uncommitted base. Internal so `applyWorkingContextPatch` cannot recurse. */
function emptyBase(sessionId: string): SessionWorkingContext {
  return {
    sessionId,
    version: 0,
    sourceSequence: 0,
    activeSubjects: [],
    currentIntent: null,
    focusTopics: [],
    activeThesisRef: null,
    activeVerdictRef: null,
    activeBullCaseRef: null,
    activeBearCaseRef: null,
    activeRiskAssessmentRef: null,
    pinnedArtifactRefs: [],
    unresolvedQuestions: [],
    userAssertions: [],
    assumptions: [],
    runningSummaryRef: null,
    updatedByTurnId: null,
    updatedAt: null,
  };
}

/** Empty read-only view for a session that has no committed version yet. */
export function defaultWorkingContext(sessionId: string): SessionWorkingContext {
  return emptyBase(sessionId);
}

/**
 * Applies a patch to the current version and produces the next version. Pure:
 * version arithmetic and defaults live here so the storage adapter only owns
 * compare-and-set atomicity.
 */
export function applyWorkingContextPatch(
  current: SessionWorkingContext | null,
  params: {
    sessionId: string;
    sourceSequence: number;
    updatedByTurnId: string | null;
    updatedAt: string | null;
    patch: WorkingContextPatch;
  },
): SessionWorkingContext {
  const base = current ?? emptyBase(params.sessionId);
  const next: SessionWorkingContext = {
    ...base,
    sessionId: params.sessionId,
    version: base.version + 1,
    sourceSequence: params.sourceSequence,
    updatedByTurnId: params.updatedByTurnId,
    updatedAt: params.updatedAt,
  };
  for (const field of WORKING_CONTEXT_PATCH_FIELDS) {
    const value = params.patch[field];
    if (value === undefined) continue;
    // Patch fields have different value types, so the assignment is widened here
    // rather than widening the persisted contract.
    (next as unknown as Record<string, unknown>)[field] = value;
  }
  return next;
}

/** True when applying the patch would not change any published field. */
export function isWorkingContextPatchNoOp(
  current: SessionWorkingContext | null,
  patch: WorkingContextPatch,
): boolean {
  if (!current) return WORKING_CONTEXT_PATCH_FIELDS.every((field) => patch[field] === undefined);
  return WORKING_CONTEXT_PATCH_FIELDS.every((field) => patch[field] === undefined
    || canonicalJson(patch[field]) === canonicalJson(current[field]));
}

export type WorkingContextConflict = 'STALE_CONTEXT_VERSION' | 'STALE_SOURCE_SEQUENCE';

/** Deterministic optimistic-concurrency rejection; a stale writer never wins. */
export class StaleWorkingContextError extends Error {
  readonly code = 'STALE_WORKING_CONTEXT';

  constructor(
    readonly conflict: WorkingContextConflict,
    readonly sessionId: string,
    message: string,
  ) {
    super(message);
    this.name = 'StaleWorkingContextError';
  }
}

/**
 * Validates a commit against the current version. Two independent guards:
 * `expectedVersion` rejects a writer that read an older version, and
 * `sourceSequence` rejects a writer that observed an older journal prefix.
 */
export function assertWorkingContextCommit(
  current: SessionWorkingContext | null,
  params: { sessionId: string; expectedVersion: number; sourceSequence: number },
): void {
  const version = current?.version ?? 0;
  if (params.expectedVersion !== version) {
    throw new StaleWorkingContextError(
      'STALE_CONTEXT_VERSION', params.sessionId,
      `Session ${params.sessionId} working context is at version ${version}, not ${params.expectedVersion}`,
    );
  }
  const observed = current?.sourceSequence ?? 0;
  if (params.sourceSequence < observed) {
    throw new StaleWorkingContextError(
      'STALE_SOURCE_SEQUENCE', params.sessionId,
      `Session ${params.sessionId} working context already observed journal sequence ${observed}, newer than ${params.sourceSequence}`,
    );
  }
}

/** Durable facts about one settled Turn; the only inputs a context patch may use. */
export interface SettledTurnFacts {
  command: string;
  /** Completed Executions of this Turn. A conversational Turn legitimately has none. */
  executions: ReadonlyArray<{ executionId: string; ticker: string; command: string }>;
  /** Execution ids whose persisted record exists through a defined store lookup. */
  judgedExecutionIds: readonly string[];
  /** Durable PR F artifacts resolved for the settled execution, when present. */
  artifactRefs?: readonly DurableArtifactRef[];
}

/**
 * Deterministic derivation from settled canonical work. Never invents artifact
 * identities: only refs resolved by the artifact store are published.
 */
export function deriveWorkingContextPatch(facts: SettledTurnFacts): WorkingContextPatch {
  const patch: WorkingContextPatch = { currentIntent: { command: facts.command } };
  // The latest completed Execution decides the active subject of the session.
  const execution = facts.executions.at(-1);
  if (!execution) return patch;
  patch.activeSubjects = [{ ticker: execution.ticker }];
  if (facts.artifactRefs && facts.artifactRefs.length > 0) {
    for (const ref of facts.artifactRefs) {
      if (ref.kind === 'BULL_CASE') patch.activeBullCaseRef = ref;
      if (ref.kind === 'BEAR_CASE') patch.activeBearCaseRef = ref;
      if (ref.kind === 'VERDICT') patch.activeVerdictRef = ref;
    }
    return patch;
  }
  if (facts.judgedExecutionIds.includes(execution.executionId)) {
    patch.activeVerdictRef = { kind: 'judgment', executionId: execution.executionId };
  }
  return patch;
}

/** Durable working-context storage. Implementations live behind the storage boundary. */
export interface WorkingContextStore {
  /** Latest committed version, or null when the session has none. */
  current(sessionId: string): Promise<SessionWorkingContext | null>;
  /** One historical version, or null when it does not exist. */
  at(sessionId: string, version: number): Promise<SessionWorkingContext | null>;
  /** Versions ordered ascending; `limit` keeps the newest ones. */
  history(sessionId: string, limit?: number): Promise<SessionWorkingContext[]>;
  /** Commits the next version under compare-and-set; rejects stale writers. */
  commit(params: {
    sessionId: string;
    expectedVersion: number;
    sourceSequence: number;
    updatedByTurnId: string | null;
    patch: WorkingContextPatch;
    at?: string;
  }): Promise<SessionWorkingContext>;
}
