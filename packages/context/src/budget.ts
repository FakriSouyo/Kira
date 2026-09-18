import { ArtifactEnvelopeSchema } from '@harness/schemas';
import {
  ContextPacketSchema,
  type ContextFocus,
  type ContextPacket,
} from './contracts.js';

export const CONTEXT_BUDGET_ESTIMATOR = 'ESTIMATED' as const;
export const DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS = 256;

export type ContextBudgetActionCode =
  | 'DROP_OPEN_QUESTION'
  | 'DROP_ASSUMPTION'
  | 'DROP_USER_ASSERTION'
  | 'REDUCE_VERDICT'
  | 'REDUCE_BULL'
  | 'REDUCE_BEAR'
  | 'DROP_PINNED_ARTIFACT'
  | 'DROP_BULL'
  | 'DROP_BEAR'
  | 'DROP_VERDICT';

export interface ContextBudgetAction {
  readonly code: ContextBudgetActionCode;
  readonly target: string;
  readonly reason: string;
}

export interface ContextModelCapabilities {
  readonly contextWindowTokens: number;
  /** The smallest configured fallback window is authoritative for one invocation. */
  readonly fallbackContextWindowTokens?: readonly number[];
}

export interface ContextBudgetRequest {
  readonly packet: ContextPacket;
  readonly render: (packet: ContextPacket) => string;
  readonly focus: ContextFocus;
  readonly modelCapabilities: ContextModelCapabilities;
  readonly basePrompt: string;
  readonly conversationHistory: string;
  /** The exact current-user prompt contribution, including any stable wrapper. */
  readonly currentUserMessage: string;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
}

export interface ContextBudgetReport {
  readonly estimator: typeof CONTEXT_BUDGET_ESTIMATOR;
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly basePromptTokens: number;
  readonly conversationHistoryTokens: number;
  readonly currentUserMessageTokens: number;
  readonly availableContextTokens: number;
  readonly estimatedOriginalTokens: number;
  readonly estimatedFinalTokens: number;
  readonly compacted: boolean;
  readonly actions: readonly ContextBudgetAction[];
}

export interface ContextBudgetResult {
  readonly originalPacket: ContextPacket;
  readonly finalPacket: ContextPacket;
  readonly renderedContext: string;
  readonly compacted: boolean;
  readonly actions: readonly ContextBudgetAction[];
  readonly report: ContextBudgetReport;
}

export class ContextBudgetError extends Error {
  readonly code = 'CONTEXT_BUDGET_EXCEEDED';

  constructor(readonly report: ContextBudgetReport) {
    super(`Required FinHarness context exceeds the available budget (${report.estimatedFinalTokens} > ${report.availableContextTokens} estimated tokens)`);
    this.name = 'ContextBudgetError';
  }
}

/** Conservative, deterministic estimate used because the runtime has no tokenizer. */
export function estimateTextTokens(value: string): number {
  return Math.ceil(Array.from(value).length / 3);
}

export function effectiveContextWindowTokens(capabilities: ContextModelCapabilities): number {
  const values = [capabilities.contextWindowTokens, ...(capabilities.fallbackContextWindowTokens ?? [])];
  for (const value of values) assertNonNegativeInteger(value, 'context window');
  return Math.min(...values);
}

export function availableContextTokens(params: {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  basePromptTokens: number;
  conversationHistoryTokens: number;
  currentUserMessageTokens: number;
  safetyMarginTokens: number;
}): number {
  for (const [name, value] of Object.entries(params)) assertNonNegativeInteger(value, name);
  return params.contextWindowTokens
    - params.reservedOutputTokens
    - params.basePromptTokens
    - params.conversationHistoryTokens
    - params.currentUserMessageTokens
    - params.safetyMarginTokens;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return value;
}

function parsePacket(value: unknown): ContextPacket {
  return freeze(ContextPacketSchema.parse(value)) as ContextPacket;
}

function action(
  code: ContextBudgetActionCode,
  target: string,
  reason: string,
): ContextBudgetAction {
  return { code, target, reason };
}

function packetWith(packet: ContextPacket, changes: Partial<{
  artifacts: ContextPacket['artifacts'];
  userAssertions: ContextPacket['userAssertions'];
  assumptions: ContextPacket['assumptions'];
  unresolvedQuestions: ContextPacket['unresolvedQuestions'];
  provenance: ContextPacket['provenance'];
}>): ContextPacket {
  return parsePacket({ ...structuredClone(packet), ...changes });
}

function reduceArtifact(item: ContextPacket['artifacts'][number]): ContextPacket['artifacts'][number] {
  const artifact = item.artifact;
  const reduced = artifact.kind === 'BULL_CASE'
    ? {
      ...artifact,
      payload: {
        ...artifact.payload,
        thesis: { ...artifact.payload.thesis, claims: artifact.payload.thesis.claims.slice(0, 1), evidenceIds: [] },
        rebuttal: { ...artifact.payload.rebuttal, claims: artifact.payload.rebuttal.claims.slice(0, 1), evidenceIds: [] },
      },
    }
    : artifact.kind === 'BEAR_CASE'
      ? {
        ...artifact,
        payload: { ...artifact.payload, counterpoints: artifact.payload.counterpoints.slice(0, 1), evidenceIds: [] },
      }
      : {
        ...artifact,
        payload: { ...artifact.payload, evidenceIds: [], claimIds: [] },
      };
  return {
    ...item,
    artifact: ArtifactEnvelopeSchema.parse(reduced),
  } as ContextPacket['artifacts'][number];
}

function requiredArtifactIds(packet: ContextPacket, focus: ContextFocus): Set<string> {
  const active = packet.artifacts.filter(item => item.roles.some(role => role !== 'PINNED_ARTIFACT'));
  const requiredRoles = focus === 'downside' || focus === 'bear'
    ? new Set(['ACTIVE_BEAR_CASE', 'ACTIVE_VERDICT'])
    : focus === 'thesis' || focus === 'bull'
      ? new Set(['ACTIVE_THESIS', 'ACTIVE_BULL_CASE'])
      : new Set(['ACTIVE_VERDICT']);
  const required = new Set(active
    .filter(item => item.roles.some(role => requiredRoles.has(role)))
    .map(item => item.artifact.artifactId));
  if (required.size === 0 && active[0]) required.add(active[0].artifact.artifactId);
  return required;
}

function artifactPriority(
  item: ContextPacket['artifacts'][number],
  required: Set<string>,
  focus: ContextFocus,
): number {
  if (required.has(item.artifact.artifactId)) return 100;
  if (item.roles.includes('PINNED_ARTIFACT')) return 60;
  const focusRoles = focus === 'downside' || focus === 'bear'
    ? ['ACTIVE_BEAR_CASE', 'ACTIVE_VERDICT']
    : focus === 'thesis' || focus === 'bull'
      ? ['ACTIVE_THESIS', 'ACTIVE_BULL_CASE']
      : ['ACTIVE_BULL_CASE', 'ACTIVE_BEAR_CASE'];
  return item.roles.some(role => focusRoles.includes(role)) ? 80 : 40;
}

function dropArtifact(packet: ContextPacket, artifactId: string): ContextPacket {
  const artifacts = packet.artifacts.filter(item => item.artifact.artifactId !== artifactId);
  const selected = new Set(artifacts.map(item => item.artifact.artifactId));
  const sourceRefs = packet.provenance.sourceRefs.filter(source =>
    source.ref.kind === 'judgment' || selected.has(source.ref.artifactId),
  );
  return packetWith(packet, {
    artifacts,
    provenance: {
      ...packet.provenance,
      sourceRefs,
      selectedArtifactIds: artifacts.map(item => item.artifact.artifactId),
    },
  });
}

function artifactDropAction(item: ContextPacket['artifacts'][number]): ContextBudgetAction {
  const prefix = item.roles.includes('PINNED_ARTIFACT') ? 'PINNED_ARTIFACT' : item.artifact.kind;
  const code = prefix === 'PINNED_ARTIFACT'
    ? 'DROP_PINNED_ARTIFACT'
    : prefix === 'BULL_CASE' ? 'DROP_BULL' : prefix === 'BEAR_CASE' ? 'DROP_BEAR' : 'DROP_VERDICT';
  return action(code, item.artifact.artifactId, 'lower-priority context removed to protect the required semantic context');
}

function makeReport(
  request: ContextBudgetRequest,
  renderedOriginal: string,
  renderedFinal: string,
  actions: readonly ContextBudgetAction[],
  available: number,
  contextWindowTokens: number,
): ContextBudgetReport {
  return {
    estimator: CONTEXT_BUDGET_ESTIMATOR,
    contextWindowTokens,
    reservedOutputTokens: request.reservedOutputTokens,
    safetyMarginTokens: request.safetyMarginTokens,
    basePromptTokens: estimateTextTokens(request.basePrompt),
    conversationHistoryTokens: estimateTextTokens(request.conversationHistory),
    currentUserMessageTokens: estimateTextTokens(request.currentUserMessage),
    availableContextTokens: available,
    estimatedOriginalTokens: estimateTextTokens(renderedOriginal),
    estimatedFinalTokens: estimateTextTokens(renderedFinal),
    compacted: actions.length > 0,
    actions,
  };
}

/**
 * Applies a finite, structural compaction plan to one immutable ContextPacket.
 * The original packet is never persisted or mutated; only the returned final
 * packet is suitable for snapshotting.
 */
export function budgetContext(request: ContextBudgetRequest): ContextBudgetResult {
  const contextWindowTokens = effectiveContextWindowTokens(request.modelCapabilities);
  assertNonNegativeInteger(request.reservedOutputTokens, 'reserved output tokens');
  assertNonNegativeInteger(request.safetyMarginTokens, 'safety margin tokens');
  const basePromptTokens = estimateTextTokens(request.basePrompt);
  const conversationHistoryTokens = estimateTextTokens(request.conversationHistory);
  const currentUserMessageTokens = estimateTextTokens(request.currentUserMessage);
  const available = availableContextTokens({
    contextWindowTokens,
    reservedOutputTokens: request.reservedOutputTokens,
    basePromptTokens,
    conversationHistoryTokens,
    currentUserMessageTokens,
    safetyMarginTokens: request.safetyMarginTokens,
  });
  const renderedOriginal = request.render(request.packet);
  const originalTokens = estimateTextTokens(renderedOriginal);
  let current = request.packet;
  const actions: ContextBudgetAction[] = [];
  const fits = (candidate: ContextPacket): boolean => estimateTextTokens(request.render(candidate)) <= available;

  if (!fits(current)) {
    const categoryStages: Array<{
      key: 'unresolvedQuestions' | 'assumptions' | 'userAssertions';
      code: ContextBudgetActionCode;
      reason: string;
    }> = [
      { key: 'unresolvedQuestions', code: 'DROP_OPEN_QUESTION', reason: 'open questions are lower priority than verified research conclusions' },
      { key: 'assumptions', code: 'DROP_ASSUMPTION', reason: 'assumptions are lower priority than verified research conclusions' },
      { key: 'userAssertions', code: 'DROP_USER_ASSERTION', reason: 'user assertions are preserved as a trust class but yield to required artifacts under pressure' },
    ];
    for (const stage of categoryStages) {
      while (current[stage.key].length > 0 && !fits(current)) {
        const values = [...current[stage.key]];
        const removed = values.pop()!;
        current = packetWith(current, { [stage.key]: values });
        actions.push(action(stage.code, removed.id, stage.reason));
      }
      if (fits(current)) break;
    }
  }

  if (!fits(current)) {
    for (let index = 0; index < current.artifacts.length && !fits(current); index++) {
      const item = current.artifacts[index]!;
      const reduced = reduceArtifact(item);
      if (JSON.stringify(reduced.artifact) === JSON.stringify(item.artifact)) continue;
      current = packetWith(current, {
        artifacts: current.artifacts.map((candidate, candidateIndex) => candidateIndex === index ? reduced : candidate),
      });
      actions.push(action(
        item.artifact.kind === 'VERDICT' ? 'REDUCE_VERDICT' : item.artifact.kind === 'BULL_CASE' ? 'REDUCE_BULL' : 'REDUCE_BEAR',
        item.artifact.artifactId,
        'structural artifact projection retained typed essential fields before dropping the artifact',
      ));
    }
  }

  if (!fits(current)) {
    const required = requiredArtifactIds(current, request.focus);
    const candidates = current.artifacts
      .map((item, index) => ({ item, index, priority: artifactPriority(item, required, request.focus) }))
      .filter(candidate => !required.has(candidate.item.artifact.artifactId))
      .sort((left, right) => left.priority - right.priority || right.index - left.index);
    for (const candidate of candidates) {
      if (fits(current)) break;
      current = dropArtifact(current, candidate.item.artifact.artifactId);
      actions.push(artifactDropAction(candidate.item));
    }
  }

  const renderedFinal = request.render(current);
  const report = makeReport(request, renderedOriginal, renderedFinal, actions, available, contextWindowTokens);
  if (report.estimatedFinalTokens > available) throw new ContextBudgetError(report);
  return {
    originalPacket: request.packet,
    finalPacket: current,
    renderedContext: renderedFinal,
    compacted: actions.length > 0,
    actions,
    report: { ...report, estimatedOriginalTokens: originalTokens },
  };
}
