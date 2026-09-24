import {
  assembleContext,
  budgetContext,
  createContextSnapshot,
  retrieveArtifactCandidates,
  resolveContextCandidates,
  selectContextCandidates,
  type ContextPacket,
  type ContextSnapshot,
  type ContextFocus,
  type ContextBudgetReport,
  type ContextDiagnosticCode,
  type ContextModelCapabilities,
  type ContextSnapshotStore,
} from '@harness/context';
import type { ArtifactStore, WorkingContextStore } from '@harness/session-core';
import {
  buildMainAgentPrompt,
  classifyConversationFocus,
  MAIN_FINHARNESS_PROMPT,
  renderContextPacket,
  type ConversationFocus,
} from '@harness/orchestrator';

export interface PreparedConversationContext {
  readonly packet: ContextPacket;
  readonly snapshot: ContextSnapshot;
  readonly rendered: string;
  readonly focus: ConversationFocus;
  readonly diagnostics: {
    readonly workingContextVersion: number;
    readonly focus: ContextFocus;
    readonly selectedArtifactIds: readonly string[];
    readonly snapshotId: string;
    readonly budget: ContextBudgetReport;
  };
}

export interface ConversationContextCoordinator {
  prepare(params: { sessionId: string; turnId: string; message: string }): Promise<PreparedConversationContext | null>;
}

export interface ConversationContextBudgetOptions {
  readonly modelCapabilities: ContextModelCapabilities;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
}

function hasMeaningfulContext(packet: ContextPacket): boolean {
  return packet.artifacts.length > 0
    || packet.userAssertions.length > 0
    || packet.assumptions.length > 0
    || packet.unresolvedQuestions.length > 0
    || packet.focusTopics.length > 0;
}

function requestedTickers(message: string): string[] {
  return [...new Set((message.match(/\b[A-Z]{4}\b/g) ?? []).map(ticker => ticker.toUpperCase()))];
}

function kindsForFocus(focus: ConversationFocus): Array<'BULL_CASE' | 'BEAR_CASE' | 'VERDICT'> {
  if (focus === 'downside' || focus === 'bear') return ['BEAR_CASE', 'VERDICT'];
  if (focus === 'thesis' || focus === 'bull') return ['BULL_CASE'];
  return ['BULL_CASE', 'BEAR_CASE', 'VERDICT'];
}

const RETRIEVAL_DIAGNOSTIC_CODES: readonly ContextDiagnosticCode[] = [
  'CANDIDATE', 'MALFORMED_ARTIFACT', 'WRONG_SESSION', 'WRONG_SUBJECT', 'WRONG_KIND',
  'DUPLICATE', 'SUPERSEDED', 'SOURCE_EXECUTION_INCOMPLETE', 'DEPENDENCY_MISSING',
];

function retrievalDiagnosticCode(reason: string, status: 'discovered' | 'skipped'): ContextDiagnosticCode {
  const match = reason.split('|').find(code => RETRIEVAL_DIAGNOSTIC_CODES.includes(code as ContextDiagnosticCode));
  return (match as ContextDiagnosticCode | undefined) ?? (status === 'skipped' ? 'MALFORMED_ARTIFACT' : 'CANDIDATE');
}

/** Composes the PR G pipeline once for one conversational Turn. */
export function createConversationContextCoordinator(
  stores: {
    readonly workingContext: WorkingContextStore;
    readonly artifacts: ArtifactStore;
    readonly contextSnapshots: ContextSnapshotStore;
  },
  budgetOptions: ConversationContextBudgetOptions,
): ConversationContextCoordinator {
  return {
    async prepare({ sessionId, turnId, message }) {
      const workingContext = await stores.workingContext.current(sessionId);
      if (!workingContext) return null;

      const focus = classifyConversationFocus(message);
      const activeTickers = new Set(workingContext.activeSubjects.map(subject => subject.ticker));
      const explicitTickers = requestedTickers(message).filter(ticker => !activeTickers.has(ticker));
      const retrieved = explicitTickers.length === 0 ? null : await retrieveArtifactCandidates({
        artifactStore: stores.artifacts,
        query: {
          sessionId,
          subjects: explicitTickers,
          allowedKinds: kindsForFocus(focus),
          focus,
        },
      });
      const resolution = await resolveContextCandidates({
        sessionId,
        workingContext,
        artifactStore: stores.artifacts,
        retrievedCandidates: retrieved?.candidates,
      });
      const selection = selectContextCandidates({ candidates: resolution.candidates, intent: { focus, subjects: explicitTickers.length > 0 ? explicitTickers : undefined } });
      const retrievalDiagnostics = (retrieved?.diagnostics ?? []).map(item => ({
        stage: 'resolver' as const,
        status: item.status,
        code: retrievalDiagnosticCode(item.reason, item.status),
        reason: item.reason,
        source: 'RETRIEVED' as const,
        artifactId: item.artifactId,
      }));
      const assembly = assembleContext({
        sessionId,
        turnId,
        workingContext,
        selectedCandidates: selection.selected,
        sourceRefs: resolution.sourceRefs,
        diagnostics: [...resolution.diagnostics, ...retrievalDiagnostics, ...selection.diagnostics],
        intent: { command: 'conversation' },
      });
      if (!hasMeaningfulContext(assembly.packet)) return null;

      const budgeted = budgetContext({
        packet: assembly.packet,
        render: renderContextPacket,
        focus,
        modelCapabilities: budgetOptions.modelCapabilities,
        basePrompt: MAIN_FINHARNESS_PROMPT,
        // PR I does not pass retained conversation history into this model call.
        conversationHistory: '',
        currentUserMessage: buildMainAgentPrompt(message),
        reservedOutputTokens: budgetOptions.reservedOutputTokens,
        safetyMarginTokens: budgetOptions.safetyMarginTokens,
      });

      // Persist only after budgeting so the snapshot is exactly what the model receives.
      const snapshot = await stores.contextSnapshots.save(createContextSnapshot({
        sessionId,
        turnId,
        packet: budgeted.finalPacket,
      }));
      return {
        packet: snapshot.packet,
        snapshot,
        rendered: budgeted.renderedContext,
        focus,
        diagnostics: {
          workingContextVersion: workingContext.version,
          focus,
          selectedArtifactIds: snapshot.packet.provenance.selectedArtifactIds,
          snapshotId: snapshot.snapshotId,
          budget: budgeted.report,
        },
      };
    },
  };
}
