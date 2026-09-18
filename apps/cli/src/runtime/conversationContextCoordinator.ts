import {
  assembleContext,
  createContextSnapshot,
  resolveContextCandidates,
  selectContextCandidates,
  type ContextPacket,
  type ContextSnapshot,
  type ContextFocus,
} from '@harness/context';
import type { FinharnessDatabase } from '@harness/database';
import { classifyConversationFocus, renderContextPacket, type ConversationFocus } from '@harness/orchestrator';

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
  };
}

export interface ConversationContextCoordinator {
  prepare(params: { sessionId: string; turnId: string; message: string }): Promise<PreparedConversationContext | null>;
}

function hasMeaningfulContext(packet: ContextPacket): boolean {
  return packet.artifacts.length > 0
    || packet.userAssertions.length > 0
    || packet.assumptions.length > 0
    || packet.unresolvedQuestions.length > 0
    || packet.focusTopics.length > 0;
}

/** Composes the PR G pipeline once for one conversational Turn. */
export function createConversationContextCoordinator(db: FinharnessDatabase): ConversationContextCoordinator {
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

      // Persist first so a context-aware model invocation can never run without audit linkage.
      const snapshot = await db.contextSnapshots.save(createContextSnapshot({
        sessionId,
        turnId,
        packet: assembly.packet,
      }));
      const rendered = renderContextPacket(snapshot.packet);
      return {
        packet: snapshot.packet,
        snapshot,
        rendered,
        focus,
        diagnostics: {
          workingContextVersion: workingContext.version,
          focus,
          selectedArtifactIds: snapshot.packet.provenance.selectedArtifactIds,
          snapshotId: snapshot.snapshotId,
        },
      };
    },
  };
}
