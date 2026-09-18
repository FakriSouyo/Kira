import {
  assembleContext,
  budgetContext,
  createContextSnapshot,
  resolveContextCandidates,
  selectContextCandidates,
  type ContextPacket,
  type ContextSnapshot,
  type ContextFocus,
  type ContextBudgetReport,
  type ContextModelCapabilities,
} from '@harness/context';
import type { FinharnessDatabase } from '@harness/database';
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

/** Composes the PR G pipeline once for one conversational Turn. */
export function createConversationContextCoordinator(
  db: FinharnessDatabase,
  budgetOptions: ConversationContextBudgetOptions,
): ConversationContextCoordinator {
  return {
    async prepare({ sessionId, turnId, message }) {
      const workingContext = await db.workingContext.current(sessionId);
      if (!workingContext) return null;

      const focus = classifyConversationFocus(message);
      const resolution = await resolveContextCandidates({
        sessionId,
        workingContext,
        artifactStore: db.artifacts,
      });
      const selection = selectContextCandidates({ candidates: resolution.candidates, intent: { focus } });
      const assembly = assembleContext({
        sessionId,
        turnId,
        workingContext,
        selectedCandidates: selection.selected,
        sourceRefs: resolution.sourceRefs,
        diagnostics: [...resolution.diagnostics, ...selection.diagnostics],
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
      const snapshot = await db.contextSnapshots.save(createContextSnapshot({
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
