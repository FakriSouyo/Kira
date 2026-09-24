import type { FinharnessDatabase } from '@harness/database';
import { createWorkingContextPublisher } from '@harness/engine';
import { UserFriendlyError } from '@harness/shared';
import { buildContext } from '../context';
import { loadConfig, type FinharnessConfig } from '../config';
import { buildCommands } from '../commands';
import type { AgentEvent } from './events';
import type { CommandHandler } from './loop';
import { ConversationController } from '../ui/conversationController';
import { repairCompletedJudgeReleases } from '../workflows/judgeCheckpoint';

/** Owns active clients and preview resources for either terminal renderer. */
export async function createHarnessSession(db: FinharnessDatabase, initialConfig: FinharnessConfig, options: {
  write?: (text: string) => void;
  events?: (event: AgentEvent) => void;
} = {}) {
  const rawWrite = options.write ?? ((text: string) => { process.stdout.write(text); });
  const controller = await ConversationController.create(db, initialConfig, event => options.events?.(event));
  const initialSelection = await db.sessions.getCurrentModelSelection(controller.snapshot.id);
  const configForSelection = (base: FinharnessConfig, selection: Awaited<ReturnType<FinharnessDatabase['sessions']['getCurrentModelSelection']>>): FinharnessConfig => {
    // Initial/legacy rows describe the config that created the Session. Only a
    // durable user choice overrides a newly supplied process configuration;
    // this preserves PR P's provider-drift compatibility gate for old runs.
    if (!selection || selection.source !== 'user') return base;
    const currentProviderId = base.llm.agent.providerId ?? base.llm.agent.provider;
    let next = base;
    if (selection.providerId !== currentProviderId && !base.providers?.[selection.providerId]) {
      throw new UserFriendlyError('INVALID_PROVIDER', `The selected provider ${selection.providerId} is not available in the active configuration.`, 'Configure the provider before opening this Session.');
    }
    if (selection.providerId !== currentProviderId && base.providers?.[selection.providerId]) {
      const providerConfig = loadConfig({ homeDir: base.homeDir, providerId: selection.providerId, mockSectors: base.sectors.mock, mockLlm: base.mockLlm });
      next = { ...base, providerSetup: providerConfig.providerSetup, providers: providerConfig.providers, llm: { ...base.llm, agent: providerConfig.llm.agent } };
    }
    return {
      ...next,
      llm: { ...next.llm, agent: { ...next.llm.agent, providerId: selection.providerId, model: selection.modelId } },
    };
  };
  const write = (text: string) => { controller.output(text); rawWrite(controller.publicText(text)); };
  const emit = (event: AgentEvent) => { controller.accept(event); options.events?.(event); };
  let config = configForSelection(initialConfig, initialSelection);
  let reasoningMode: 'usual' | 'reasoning' = 'usual';
  const context = buildContext(db, config, { sessionId: controller.snapshot.id });
  const cleanup: Array<() => Promise<void>> = [];
  type PreparedContext = { config: FinharnessConfig; context: ReturnType<typeof buildContext> };
  const prepareContext = (next: FinharnessConfig, sessionId: string): PreparedContext => ({
    config: next,
    context: buildContext(db, next, { sessionId }),
  });
  const commitContext = (prepared: PreparedContext) => {
    config = prepared.config;
    Object.assign(context, prepared.context);
  };
  const applyConfig = (next: FinharnessConfig, sessionId = controller.snapshot.id) => {
    commitContext(prepareContext(next, sessionId));
  };
  const prepareSession = async (sessionId: string): Promise<PreparedContext> => {
    const loaded = loadConfig({ homeDir: initialConfig.homeDir, mockSectors: initialConfig.sectors.mock, mockLlm: initialConfig.mockLlm });
    const next = configForSelection(loaded, await db.sessions.getCurrentModelSelection(sessionId));
    return prepareContext(next, sessionId);
  };
  const reload = async () => {
    const loaded = loadConfig({ homeDir: initialConfig.homeDir, mockSectors: initialConfig.sectors.mock, mockLlm: initialConfig.mockLlm });
    applyConfig(configForSelection(loaded, await db.sessions.getCurrentModelSelection(controller.snapshot.id)));
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
    workingContext: db.workingContext,
    artifacts: db.artifacts,
    judgments: db.judgments,
    readJournal: sessionId => db.journal.read(sessionId),
    appendAuditEvent: payload => controller.append(payload),
  });
  await repairCompletedJudgeReleases({ db, sessionId: controller.snapshot.id });
  const startupArtifacts = await db.sessions.getSessionArtifacts(controller.snapshot.id);
  for (const turn of startupArtifacts.turns) {
    if (turn.status !== 'completed') continue;
    await publisher.publishAfterSettledTurn({
      sessionId: controller.snapshot.id,
      turnId: turn.id,
      artifacts: startupArtifacts,
    });
  }
  /** Reconciles context audit events from durable versions after a failed append. */
  const publishAfterSettledTurn = async (turnId: string) => {
    const artifacts = await db.sessions.getSessionArtifacts(controller.snapshot.id);
    return await publisher.publishAfterSettledTurn({ sessionId: controller.snapshot.id, turnId, artifacts });
  };
  const switchToPreparedSession = async (sessionId: string, prepared: PreparedContext) => {
    const previousSessionId = controller.snapshot.id;
    try {
      await controller.open(sessionId);
      await publisher.reconcileJournal(sessionId);
    } catch (error) {
      if (controller.snapshot.id !== previousSessionId) await controller.open(previousSessionId);
      throw error;
    }
    commitContext(prepared);
  };
  await publisher.reconcileJournal(controller.snapshot.id);
  const resolveControlExecution = async (name: string, args: string[]) => {
    if (name === 'resume' && args.length === 0) {
      throw new UserFriendlyError('MISSING_ARG', 'No executionId provided', 'Usage: /resume <executionId>');
    }
    if (name === 'continue' && args.length > 0) {
      throw new UserFriendlyError('INVALID_ARG', '/continue does not take an executionId', 'Use /resume <executionId> for an explicit target.');
    }
    const artifacts = await db.sessions.getSessionArtifacts(controller.snapshot.id);
    const candidates = artifacts.executions.filter(execution => execution.command === 'judge' && execution.status === 'interrupted');
    const execution = name === 'continue'
      ? candidates.length === 1
        ? candidates[0]
        : candidates.length === 0
          ? undefined
          : (() => { throw new UserFriendlyError('AMBIGUOUS_RESUME', 'More than one interrupted Judge execution is available.', `Use /resume <executionId>: ${candidates.map(candidate => candidate.id).join(', ')}`); })()
      : candidates.find(candidate => candidate.id === args[0]);
    if (!execution) {
      throw new UserFriendlyError('RESUME_NOT_FOUND', `Interrupted Judge execution ${args[0] ?? ''} was not found in this Session.`, 'Use /history to inspect this Session, or start a new /judge.');
    }
    const turn = artifacts.turns.find(candidate => candidate.id === execution.turnId);
    if (!turn || turn.status !== 'running') {
      throw new UserFriendlyError('RESUME_TURN_UNAVAILABLE', `Execution ${execution.id} no longer has a running parent Turn.`, 'Start a new /judge.');
    }
    return execution;
  };
  for (const [name, handler] of handlers) {
    commands.set(name, async (args, execution) => {
      const input = controller.safeInput(execution?.input ?? `/${name}${args.length ? ` ${args.join(' ')}` : ''}`);
      if (name === 'resume' || name === 'continue') {
        const target = await resolveControlExecution(name, args);
        const lifecycle = { sessionId: target.sessionId, turnId: target.turnId };
        controller.attachTurn(target.turnId, target.id);
        let turnSettled = false;
        try {
          controller.user(input);
          const result = await handler(args, { ...execution, input, lifecycle, resume: { executionId: target.id, turnId: target.turnId } });
          const after = (await db.sessions.getSessionArtifacts(target.sessionId)).executions.find(candidate => candidate.id === target.id);
          if (after && after.status !== 'interrupted') {
            const status = after.status === 'completed' ? 'completed' : after.status === 'cancelled' ? 'stopped' : 'failed';
            await db.sessions.settleTurn(target.turnId, status);
            turnSettled = true;
            await publishAfterSettledTurn(target.turnId);
            controller.settleTurn(target.turnId, status === 'completed' ? 'completed' : status === 'stopped' ? 'cancelled' : 'failed');
          } else controller.releaseAttachedTurn();
          return result;
        } catch (error) {
          const after = (await db.sessions.getSessionArtifacts(target.sessionId)).executions.find(candidate => candidate.id === target.id);
          if (!turnSettled && after && after.status !== 'interrupted' && after.status !== 'running') {
            const status = after.status === 'completed' ? 'completed' : after.status === 'cancelled' ? 'stopped' : 'failed';
            await db.sessions.settleTurn(target.turnId, status);
            turnSettled = true;
            controller.settleTurn(target.turnId, status === 'completed' ? 'completed' : status === 'stopped' ? 'cancelled' : 'failed');
          } else controller.releaseAttachedTurn();
          throw error;
        }
      }
      const turn = await db.sessions.createTurn({ sessionId: controller.snapshot.id, input, command: name });
      let turnSettled = false;
      try {
        controller.beginTurn(turn.id);
        if (name === 'new') {
          await db.sessions.settleTurn(turn.id, 'completed');
          turnSettled = true;
          controller.settleTurn(turn.id, 'completed');
          const target = await controller.createNewConversation();
          await switchToPreparedSession(target.id, await prepareSession(target.id));
          return;
        }
        controller.user(input);
        const result = await handler(args, { ...execution, input, lifecycle: { sessionId: turn.sessionId, turnId: turn.id } });
        if (result?.reload) await reload();
        await db.sessions.settleTurn(turn.id, 'completed');
        turnSettled = true;
        await publishAfterSettledTurn(turn.id);
        controller.settleTurn(turn.id, 'completed');
        if (result?.suspend) {
          const suspend = result.suspend;
          return { ...result, suspend: async () => { try { await suspend(); } finally { await reload(); } } };
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
    async openConversation(id: string) {
      await switchToPreparedSession(id, await prepareSession(id));
    },
    get config() { return config; },
    /** Session-local model selection; durable per Session and never writes config.json. */
    async setModel(model: string) {
      if (!model.trim()) throw new UserFriendlyError('INVALID_MODEL', 'Model ID cannot be empty', 'Choose a discovered model or enter its exact ID.');
      const current = await db.sessions.getCurrentModelSelection(controller.snapshot.id);
      await db.sessions.selectModel({
        sessionId: controller.snapshot.id,
        providerId: current?.providerId ?? config.llm.agent.providerId ?? config.llm.agent.provider,
        modelId: model,
        source: 'user',
      });
      applyConfig({
        ...config,
        llm: { ...config.llm, agent: { ...config.llm.agent, providerId: current?.providerId ?? config.llm.agent.providerId ?? config.llm.agent.provider, model } },
      });
    },
    /** Provider-scoped selection changes endpoint, protocol, credentials and model together without config.json writes. */
    async setProviderModel(providerId: string, model: string) {
      const selected = loadConfig({ homeDir: config.homeDir, providerId, skipRepair: true, mockSectors: config.sectors.mock, mockLlm: config.mockLlm });
      if (selected.providerSetup && !selected.providerSetup.models.some(candidate => candidate.id === model)) {
        throw new UserFriendlyError('INVALID_MODEL', `Model ${model} does not belong to provider ${providerId}`, 'Choose a discovered model for this provider.');
      }
      await db.sessions.selectModel({ sessionId: controller.snapshot.id, providerId, modelId: model, source: 'user' });
      applyConfig({
        ...config,
        providerSetup: selected.providerSetup,
        providers: selected.providers,
        llm: { ...config.llm, agent: { ...selected.llm.agent, providerId, model } },
      });
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
        const recordConversationModelCall = async (metadata: import('@harness/llm').LLMCallMetadata) => {
          await db.sessions.recordModelCall({
            callId: `call_${turn.id}`,
            turnId: turn.id,
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
            latencyMs: Math.max(0, Math.round(performance.now() - modelCallStarted)),
            finishReason: metadata.finishReason,
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
