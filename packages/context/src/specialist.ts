import { ClaimSchema, BearCounterpointContextSchema, type BearCounterpointContext, type Claim, type Evidence } from '@harness/schemas';
import { buildEvidenceZone } from '@harness/shared';
import {
  SpecialistContextPayloadSchema,
  SpecialistPhaseSchema,
  SpecialistRoleSchema,
  type SpecialistContextPayload,
  type SpecialistPhase,
  type SpecialistRole,
} from './specialistContracts.js';
import { SpecialistContextPacketSchema, type SpecialistContextPacket } from './contracts.js';
import {
  budgetStructuredContext,
  type ContextBudgetAction,
  type ContextModelCapabilities,
  type StructuredContextBudgetResult,
} from './budget.js';

export interface SpecialistContextParams {
  readonly sessionId: string;
  readonly turnId: string;
  readonly executionId: string;
  readonly ticker: string;
  readonly roundNumber: number;
  readonly evidence: readonly Evidence[];
  readonly role: SpecialistRole;
  readonly phase: SpecialistPhase;
  readonly bullClaims?: readonly Claim[];
  readonly bearCounterpoints?: readonly BearCounterpointContext[];
  readonly rebuttalClaims?: readonly Claim[];
  readonly discussion?: readonly { agent: string; type: string; content: string }[];
  readonly availableCategories?: { marketMomentum: boolean; risk: boolean };
}

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    throw new Error(`Specialist ${name} is required for this role and phase`);
  }
  return value;
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`Specialist ${name} must not be empty`);
}

function validateClaimEvidence(claims: readonly Claim[], evidenceIds: ReadonlySet<string>): Claim[] {
  const parsed = ClaimSchema.array().parse(claims);
  for (const claim of parsed) {
    for (const evidenceId of claim.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) throw new Error(`Specialist claim ${claim.claimId} cites evidence outside the selected execution`);
    }
  }
  return parsed;
}

function validateCounterpoints(counterpoints: readonly BearCounterpointContext[], claims: ReadonlySet<string>, evidenceIds: ReadonlySet<string>): BearCounterpointContext[] {
  const parsed = BearCounterpointContextSchema.array().parse(counterpoints);
  for (const counterpoint of parsed) {
    if (!claims.has(counterpoint.targetClaimId)) throw new Error(`Specialist counterpoint targets an unknown claim ${counterpoint.targetClaimId}`);
    if ('evidenceIds' in counterpoint && counterpoint.evidenceIds.some(id => !evidenceIds.has(id))) {
      throw new Error(`Specialist counterpoint ${counterpoint.counterpointId} cites Evidence outside the selected execution`);
    }
  }
  return parsed;
}

function validatePhase(params: SpecialistContextParams, bullClaims: Claim[] | undefined, counterpoints: BearCounterpointContext[] | undefined, rebuttalClaims: Claim[] | undefined): void {
  const { role, phase } = params;
  if (role === 'BULL' && phase === 'THESIS') return;
  if (role === 'BEAR' && phase === 'CHALLENGE') { requireValue(bullClaims, 'Bull claims'); return; }
  if (role === 'BULL' && phase === 'REBUTTAL') { requireValue(bullClaims, 'Bull claims'); requireValue(counterpoints, 'Bear counterpoints'); return; }
  if (role === 'BEAR' && phase === 'RECHALLENGE') { requireValue(bullClaims, 'Bull claims'); return; }
  if (role === 'JUDGE' && (phase === 'EVALUATION' || phase === 'RESOLUTION')) {
    requireValue(bullClaims, 'Bull claims');
    requireValue(counterpoints, 'Bear counterpoints');
    requireValue(rebuttalClaims, 'rebuttal claims');
    requireValue(params.discussion, 'discussion');
    requireValue(params.availableCategories, 'available categories');
    return;
  }
  throw new Error(`Unsupported specialist role/phase combination: ${role}/${phase}`);
}

export function assembleSpecialistContext(params: SpecialistContextParams): SpecialistContextPacket {
  for (const [name, value] of Object.entries({
    sessionId: params.sessionId, turnId: params.turnId, executionId: params.executionId, ticker: params.ticker,
  })) assertNonEmpty(value, name);
  SpecialistRoleSchema.parse(params.role);
  SpecialistPhaseSchema.parse(params.phase);
  if (!Number.isInteger(params.roundNumber) || params.roundNumber < 1) throw new Error('Specialist roundNumber must be positive');
  if (params.evidence.length < 1) throw new Error('Specialist evidence is required');

  const parsedEvidence = SpecialistContextPayloadSchema.shape.evidence.parse(params.evidence);
  const evidenceIds = parsedEvidence.map((item) => item.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error('Specialist evidence IDs must be unique');
  for (const item of parsedEvidence) {
    if (item.runId !== params.executionId) throw new Error(`Specialist evidence ${item.id} belongs to another execution`);
    if (item.ticker !== params.ticker) throw new Error(`Specialist evidence ${item.id} belongs to another subject`);
  }
  const evidenceIdSet = new Set(evidenceIds);
  const bullClaims = params.bullClaims === undefined ? undefined : validateClaimEvidence(params.bullClaims, evidenceIdSet);
  const rebuttalClaims = params.rebuttalClaims === undefined ? undefined : validateClaimEvidence(params.rebuttalClaims, evidenceIdSet);
  const claimIds = new Set([...(bullClaims ?? []), ...(rebuttalClaims ?? [])].map((claim) => claim.claimId));
  const counterpoints = params.bearCounterpoints === undefined ? undefined : validateCounterpoints(params.bearCounterpoints, claimIds, evidenceIdSet);
  validatePhase(params, bullClaims, counterpoints, rebuttalClaims);

  const payload: SpecialistContextPayload = SpecialistContextPayloadSchema.parse({
    schemaVersion: 1,
    contextKind: 'SPECIALIST',
    sessionId: params.sessionId,
    turnId: params.turnId,
    executionId: params.executionId,
    subject: { ticker: params.ticker },
    role: params.role,
    phase: params.phase,
    roundNumber: params.roundNumber,
    evidence: parsedEvidence,
    evidenceIds,
    ...(bullClaims ? { bullClaims } : {}),
    ...(counterpoints ? { bearCounterpoints: counterpoints } : {}),
    ...(rebuttalClaims ? { rebuttalClaims } : {}),
    ...(params.discussion ? { discussion: params.discussion } : {}),
    ...(params.availableCategories ? { availableCategories: params.availableCategories } : {}),
  });

  return SpecialistContextPacketSchema.parse({
    schemaVersion: 1,
    sessionId: params.sessionId,
    turnId: params.turnId,
    activeSubjects: [{ ticker: params.ticker }],
    intent: { command: 'judge' },
    focusTopics: [],
    artifacts: [],
    userAssertions: [],
    assumptions: [],
    unresolvedQuestions: [],
    provenance: {
      sessionId: params.sessionId,
      turnId: params.turnId,
      workingContextVersion: 0,
      sourceContextSequence: 0,
      sourceRefs: [],
      selectedArtifactIds: [],
      diagnostics: [],
    },
    contextKind: 'SPECIALIST',
    specialist: payload,
  }) as SpecialistContextPacket;
}

export interface RenderedSpecialistContext {
  readonly evidenceZone: string;
  readonly roleZone: string;
  readonly rendered: string;
}

export function renderSpecialistContext(context: SpecialistContextPacket): RenderedSpecialistContext {
  const parsed = SpecialistContextPacketSchema.parse(context);
  const specialist = parsed.specialist;
  const upstream: Record<string, unknown> = {};
  if (specialist.bullClaims) upstream.bullClaims = specialist.bullClaims;
  if (specialist.bearCounterpoints) upstream.bearCounterpoints = specialist.bearCounterpoints;
  if (specialist.rebuttalClaims) upstream.rebuttalClaims = specialist.rebuttalClaims;
  if (specialist.discussion) upstream.discussion = specialist.discussion;
  if (specialist.availableCategories) upstream.availableCategories = specialist.availableCategories;
  const evidenceZone = buildEvidenceZone(specialist.subject.ticker, specialist.evidence);
  const roleZone = [
    'SPECIALIST CONTEXT',
    `ROLE: ${specialist.role}`,
    `PHASE: ${specialist.phase}`,
    `SUBJECT: ${specialist.subject.ticker}`,
    'AUTHORITATIVE UPSTREAM DEBATE STATE:',
    JSON.stringify(upstream),
  ].join('\n');
  return { evidenceZone, roleZone, rendered: `${evidenceZone}\n\n${roleZone}` };
}

function removeDiscussion(context: SpecialistContextPacket, index: number): SpecialistContextPacket {
  const discussion = context.specialist.discussion ?? [];
  return SpecialistContextPacketSchema.parse({
    ...structuredClone(context),
    specialist: { ...structuredClone(context.specialist), discussion: discussion.filter((_, itemIndex) => itemIndex !== index) },
  }) as SpecialistContextPacket;
}

function compactSpecialistContext(
  context: SpecialistContextPacket,
  fits: (candidate: SpecialistContextPacket) => boolean,
): { packet: SpecialistContextPacket; actions: readonly ContextBudgetAction[] } {
  let current = context;
  const actions: ContextBudgetAction[] = [];
  const discussion = current.specialist.discussion ?? [];
  for (let index = discussion.length - 1; index >= 0 && !fits(current); index -= 1) {
    const removed = discussion[index]!;
    current = removeDiscussion(current, index);
    actions.push({ code: 'DROP_DISCUSSION', target: `${removed.agent}:${removed.type}:${index}`, reason: 'lower-priority debate transcript removed before authoritative claims and Evidence' });
  }
  return { packet: current, actions };
}

export interface SpecialistBudgetRequest {
  readonly context: SpecialistContextPacket;
  readonly modelCapabilities: ContextModelCapabilities;
  readonly basePrompt: string;
  readonly currentUserMessage: string;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
}

export type SpecialistBudgetResult = StructuredContextBudgetResult<SpecialistContextPacket>;

/** Specialist contexts share the same accounting and fail closed if Evidence cannot fit. */
export function budgetSpecialistContext(request: SpecialistBudgetRequest): SpecialistBudgetResult {
  const result = budgetStructuredContext<SpecialistContextPacket>({
    packet: request.context,
    render: (context) => renderSpecialistContext(context).rendered,
    modelCapabilities: request.modelCapabilities,
    basePrompt: request.basePrompt,
    conversationHistory: '',
    currentUserMessage: request.currentUserMessage,
    reservedOutputTokens: request.reservedOutputTokens,
    safetyMarginTokens: request.safetyMarginTokens,
  }, compactSpecialistContext);
  return result;
}
