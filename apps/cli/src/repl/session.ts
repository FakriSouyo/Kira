import type { FinharnessDatabase } from '@harness/database';
import { UserFriendlyError } from '@harness/shared';
import { buildContext } from '../context';
import { loadConfig, writeActiveModel, writeActiveProviderModel, type FinharnessConfig } from '../config';
import { buildCommands } from '../commands';
import type { AgentEvent } from './events';
import type { CommandHandler } from './loop';
import { ConversationController } from '../ui/conversationController';
import { createWorkingContextPublisher } from './workingContext';

/** Owns active clients and preview resources for either terminal renderer. */
export async function createHarnessSession(db: FinharnessDatabase, initialConfig: FinharnessConfig, options: {
  write?: (text: string) => void;
  events?: (event: AgentEvent) => void;
} = {}) {
  const rawWrite = options.write ?? ((text: string) => { process.stdout.write(text); });
  const controller = await ConversationController.create(db, initialConfig, event => options.events?.(event));
  const write = (text: string) => { controller.output(text); rawWrite(controller.publicText(text)); };
  const emit = (event: AgentEvent) => { controller.accept(event); options.events?.(event); };
  let config = initialConfig;
  let reasoningMode: 'usual' | 'reasoning' = 'usual';
  const context = buildContext(db, config);
  const cleanup: Array<() => Promise<void>> = [];
  const applyConfig = (next: FinharnessConfig) => {
    config = next;
    Object.assign(context, buildContext(db, config));
  };
  const reload = () => {
    applyConfig(loadConfig({ homeDir: initialConfig.homeDir, mockSectors: initialConfig.sectors.mock, mockLlm: initialConfig.mockLlm }));
  };
  const handlers = buildCommands(context, {
    ...options,
    events: emit,
    renderEvents: Boolean(options.events),
    write,
    onCleanup: (fn) => cleanup.push(fn),
    getReasoningMode: () => reasoningMode,
  });
  const terminalTurnState = async (turnId: string, error: unknown, signal?: AbortSignal) => {
    const artifacts = await db.sessions.getSessionArtifacts(controller.snapshot.id);
    const executions = artifacts.executions.filter(execution => execution.turnId === turnId);
    if (executions.some(execution => execution.status === 'completed')) return 'completed' as const;
    if (executions.some(execution => execution.status === 'cancelled')) return 'stopped' as const;
    if (executions.some(execution => execution.status === 'failed')) return 'failed' as const;
    return signal?.aborted || (error instanceof UserFriendlyError && error.code === 'ABORTED')
      ? 'stopped' as const
      : 'failed' as const;
  };
  const commands = new Map<string, CommandHandler>();
  const publisher = createWorkingContextPublisher({
    db,
    append: (payload) => controller.append(payload),
  });
  /** Reconciles context audit events from durable versions after a failed append. */
  const publishAfterSettledTurn = async (turnId: string) => {
    const artifacts = await db.sessions.getSessionArtifacts(controller.snapshot.id);
    return await publisher.publishAfterSettledTurn({ sessionId: controller.snapshot.id, turnId, artifacts });
  };
  await publisher.reconcileJournal(controller.snapshot.id);
  for (const [name, handler] of handlers) {
    commands.set(name, async (args, execution) => {
      const input = controller.safeInput(execution?.input ?? `/${name}${args.length ? ` ${args.join(' ')}` : ''}`);
      const turn = await db.sessions.createTurn({ sessionId: controller.snapshot.id, input, command: name });
      let turnSettled = false;
      try {
        controller.beginTurn(turn.id);
        if (name === 'new') {
          await db.sessions.settleTurn(turn.id, 'completed');
          turnSettled = true;
          controller.settleTurn(turn.id, 'completed');
          await controller.newConversation();
          return;
        }
        controller.user(input);
        const result = await handler(args, { ...execution, input, lifecycle: { sessionId: turn.sessionId, turnId: turn.id } });
        if (result?.reload) reload();
        await db.sessions.settleTurn(turn.id, 'completed');
        turnSettled = true;
        await publishAfterSettledTurn(turn.id);
        controller.settleTurn(turn.id, 'completed');
        if (result?.suspend) {
          const suspend = result.suspend;
          return { ...result, suspend: async () => { try { await suspend(); } finally { reload(); } } };
        }
        return result;
      } catch (error) {
        if (!turnSettled) {
          const status = await terminalTurnState(turn.id, error, execution?.signal);
          await db.sessions.settleTurn(turn.id, status);
          turnSettled = true;
          controller.settleTurn(turn.id, status === 'completed' ? 'completed' : status === 'stopped' ? 'cancelled' : 'failed');
        }
        throw error;
      }
    });
  }

  return {
    context, commands,
    get conversation() { return controller.snapshot; },
    async openConversation(id: string) { await controller.open(id); await publisher.reconcileJournal(id); },
    get config() { return config; },
    /** Session-local model selection; rebuilds pure clients and affects future turns. */
    setModel(model: string) {
      if (!model.trim()) throw new UserFriendlyError('INVALID_MODEL', 'Model ID cannot be empty', 'Choose a discovered model or enter its exact ID.');
      writeActiveModel(config.homeDir, model);
      applyConfig({
        ...config,
        llm: { ...config.llm, agent: { ...config.llm.agent, model } },
      });
    },
    /** Provider-scoped selection changes endpoint, protocol, credentials and model together. */
    setProviderModel(providerId: string, model: string) {
      writeActiveProviderModel(config.homeDir, providerId, model);
      reload();
    },
    /** Usual keeps the standard debate; Reasoning enables the extra challenge/rebuttal pass. */
    setReasoning(mode: 'usual' | 'reasoning') { reasoningMode = mode; },
    get reasoningMode() { return reasoningMode; },
    /** Records a TTY-owned command whose presentation is handled locally. */
    async recordLocalInput(text: string): Promise<void> {
      const input = controller.safeInput(text.trim());
      const command = input.replace(/^\//, '').split(/\s+/, 1)[0]?.toLowerCase() || 'local';
      const turn = await db.sessions.createTurn({ sessionId: controller.snapshot.id, input, command });
      let turnSettled = false;
      try {
        controller.beginTurn(turn.id);
        controller.user(input);
        await db.sessions.settleTurn(turn.id, 'completed');
        turnSettled = true;
        await publishAfterSettledTurn(turn.id);
        controller.settleTurn(turn.id, 'completed');
      } catch (error) {
        if (!turnSettled) {
          await db.sessions.settleTurn(turn.id, 'failed');
          turnSettled = true;
          controller.settleTurn(turn.id, 'failed');
        }
        throw error;
      }
    },
    /**
     * Conversational routing (Audit doc C1/C2): input tanpa prefix "/" selalu
     * ditangani sebagai percakapan biasa oleh MainFinHarnessAgent — TIDAK
     * lewat Intent Router, sehingga "menurutmu BBCA bagus ga" tidak memicu
     * workflow research tanpa command eksplisit (/research, /judge, dst).
     */
    async handleNaturalLanguage(text: string, execution?: { signal?: AbortSignal }): Promise<void> {
      const question = text.trim();
      if (!question) return;
      const turn = await db.sessions.createTurn({ sessionId: controller.snapshot.id, input: question, command: 'conversation' });
      let turnSettled = false;
      const id = `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      try {
        controller.beginTurn(turn.id);
        controller.user(question);
        emit({ type: 'conversation.user', id, content: question, createdAt: Date.now() });
        emit({ type: 'conversation.start', id, mode: 'conversation' });
        const preparedContext = await context.conversationContext.prepare({
          sessionId: turn.sessionId,
          turnId: turn.id,
          message: question,
        });
        const modelCallStarted = performance.now();
        const recordConversationModelCall = async () => {
          await db.sessions.recordModelCall({
            callId: `call_${turn.id}`,
            turnId: turn.id,
            subagent: 'conversation',
            provider: config.llm.agent.provider,
            model: config.llm.agent.model,
            attempt: 1,
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            totalTokens: null,
            latencyMs: Math.max(0, Math.round(performance.now() - modelCallStarted)),
            finishReason: 'stop',
            cost: null,
            currency: null,
            contextSnapshotId: preparedContext?.snapshot.snapshotId ?? null,
          });
        };
        const modelOptions = {
          abortSignal: execution?.signal,
          ...(preparedContext ? {
            context: {
              snapshotId: preparedContext.snapshot.snapshotId,
              rendered: preparedContext.rendered,
            },
          } : {}),
          onModelCall: recordConversationModelCall,
        } as const;
        if (options.events) {
          // TTY: alirkan token ke transcript conversation supaya tampil streaming.
          for await (const chunk of context.mainAgent.stream(question, modelOptions)) {
            if (execution?.signal?.aborted) throw new UserFriendlyError('ABORTED', 'Response cancelled', 'Enter another message when ready.');
            emit({ type: 'conversation.delta', id, content: chunk });
          }
          emit({ type: 'conversation.complete', id });
        } else {
          // Non-TTY/readline: jawaban utuh, tulis langsung.
          const answer = await context.mainAgent.respond(question, modelOptions);
          emit({ type: 'conversation.delta', id, content: answer });
          emit({ type: 'conversation.complete', id });
          rawWrite(`${controller.publicText(answer)}\n\n`);
        }
        await db.sessions.settleTurn(turn.id, 'completed');
        turnSettled = true;
        await publishAfterSettledTurn(turn.id);
        controller.settleTurn(turn.id, 'completed');
      } catch (error) {
        if (!turnSettled) {
          const stopped = execution?.signal?.aborted || (error instanceof UserFriendlyError && error.code === 'ABORTED');
          emit({
            type: 'conversation.failed', id,
            error: stopped
              ? { code: 'ABORTED', message: 'Response cancelled', suggestion: 'Enter another message when ready.' }
              : { code: 'CONVERSATION_ERROR', message: 'Gagal menghasilkan respons percakapan.', suggestion: 'Coba lagi, atau gunakan /judge untuk analisis berbasis evidence.' },
          });
          await db.sessions.settleTurn(turn.id, stopped ? 'stopped' : 'failed');
          turnSettled = true;
          controller.settleTurn(turn.id, stopped ? 'cancelled' : 'failed');
        }
        throw error;
      }
    },
    async close() { for (const fn of cleanup.splice(0).reverse()) await fn(); },
  };
}
