import type { MainAgentCallOptions, MainFinHarnessAgent } from '@harness/orchestrator';
import type { ResearchSessionStore } from '@harness/session-core';
import type { ConversationContextCoordinator, PreparedConversationContext } from './contextCoordinator.js';

export interface ConversationResponseDependencies {
  readonly context: ConversationContextCoordinator;
  readonly agent: Pick<MainFinHarnessAgent, 'respond' | 'stream'>;
  readonly sessions: Pick<ResearchSessionStore, 'recordModelCall'>;
}

export interface ConversationResponseInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly message: string;
  readonly signal?: AbortSignal;
}

function callOptions(
  dependencies: ConversationResponseDependencies,
  input: ConversationResponseInput,
  prepared: PreparedConversationContext | null,
  startedAt: number,
): MainAgentCallOptions {
  return {
    abortSignal: input.signal,
    ...(prepared ? {
      context: {
        snapshotId: prepared.snapshot.snapshotId,
        rendered: prepared.rendered,
      },
    } : {}),
    onModelCall: async metadata => {
      await dependencies.sessions.recordModelCall({
        callId: `call_${input.turnId}`,
        turnId: input.turnId,
        subagent: 'conversation',
        provider: metadata.provider,
        model: metadata.model,
        providerId: metadata.providerId ?? null,
        modelId: metadata.modelId ?? null,
        adapterId: metadata.adapterId ?? null,
        protocol: metadata.protocol ?? null,
        runtimeFingerprint: metadata.runtimeFingerprint ?? null,
        attempt: 1,
        inputTokens: metadata.inputTokens,
        outputTokens: metadata.outputTokens,
        cachedInputTokens: metadata.cachedInputTokens,
        totalTokens: metadata.totalTokens,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        finishReason: metadata.finishReason,
        cost: null,
        currency: null,
        contextSnapshotId: prepared?.snapshot.snapshotId ?? null,
      });
    },
  };
}

export async function conversationRespondWorkflow(
  dependencies: ConversationResponseDependencies,
  input: ConversationResponseInput,
): Promise<string> {
  const prepared = await dependencies.context.prepare({
    sessionId: input.sessionId,
    turnId: input.turnId,
    message: input.message,
  });
  const startedAt = performance.now();
  return await dependencies.agent.respond(input.message, callOptions(dependencies, input, prepared, startedAt));
}

export async function* conversationStreamWorkflow(
  dependencies: ConversationResponseDependencies,
  input: ConversationResponseInput,
): AsyncIterable<string> {
  const prepared = await dependencies.context.prepare({
    sessionId: input.sessionId,
    turnId: input.turnId,
    message: input.message,
  });
  const startedAt = performance.now();
  for await (const chunk of dependencies.agent.stream(input.message, callOptions(dependencies, input, prepared, startedAt))) {
    yield chunk;
  }
}
