import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMClientLike, LLMCallMetadata } from '@harness/llm';
import { MainFinHarnessAgent, type MainAgentCallOptions } from '@harness/orchestrator';
import type { ResearchSessionStore, ModelCallRecord } from '@harness/session-core';
import type { ConversationContextCoordinator, PreparedConversationContext } from '../src/conversation/contextCoordinator.js';
import {
  conversationRespondWorkflow,
  conversationStreamWorkflow,
  type ConversationResponseDependencies,
  type ConversationResponseInput,
} from '../src/conversation/responseWorkflow.js';

const INPUT: ConversationResponseInput = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  message: 'What is the downside risk?',
};

const METADATA: LLMCallMetadata = {
  provider: 'openai',
  model: 'runtime-model',
  providerId: 'logical-provider',
  modelId: 'vendor-model',
  adapterId: 'openai-adapter',
  protocol: 'responses',
  runtimeFingerprint: 'runtime-fingerprint',
  inputTokens: 11,
  outputTokens: 7,
  cachedInputTokens: 3,
  totalTokens: 18,
  latencyMs: 999,
  finishReason: 'stop',
};

afterEach(() => vi.restoreAllMocks());

function preparedContext(snapshotId = 'snapshot-1'): PreparedConversationContext {
  return {
    snapshot: { snapshotId },
    rendered: 'Prepared financial context',
  } as PreparedConversationContext;
}

function harness(prepared: PreparedConversationContext | null = preparedContext()) {
  const prepare = vi.fn(async (_params: Parameters<ConversationContextCoordinator['prepare']>[0]) => prepared);
  const recordModelCall = vi.fn(async (_params: Parameters<ResearchSessionStore['recordModelCall']>[0]) => ({} as ModelCallRecord));
  const respond = vi.fn(async (_message: string, options?: MainAgentCallOptions) => {
    await options?.onModelCall?.(METADATA);
    return 'Exact response';
  });
  const stream = vi.fn(async function* (_message: string, options?: MainAgentCallOptions) {
    yield 'first';
    yield ' second';
    await options?.onModelCall?.(METADATA);
  });
  const dependencies: ConversationResponseDependencies = {
    context: { prepare } as ConversationContextCoordinator,
    agent: { respond, stream },
    sessions: { recordModelCall } as Pick<ResearchSessionStore, 'recordModelCall'>,
  };
  return { dependencies, prepare, recordModelCall, respond, stream };
}

async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const chunk of chunks) result.push(chunk);
  return result;
}

function realAgentForFastPaths() {
  const llm = {
    generateTextResult: vi.fn(),
    streamTextResult: vi.fn(),
  } as unknown as Pick<LLMClientLike, 'generateTextResult' | 'streamTextResult'>;
  return { agent: new MainFinHarnessAgent(llm), llm };
}

describe('host-neutral conversation response workflows', () => {
  it('prepares once, binds prepared context and signal, returns the answer, and records exact successful provenance', async () => {
    const test = harness();
    const signal = new AbortController().signal;
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(137);

    await expect(conversationRespondWorkflow(test.dependencies, { ...INPUT, signal })).resolves.toBe('Exact response');

    expect(test.prepare).toHaveBeenCalledTimes(1);
    expect(test.prepare).toHaveBeenCalledWith({ sessionId: INPUT.sessionId, turnId: INPUT.turnId, message: INPUT.message });
    expect(test.respond).toHaveBeenCalledWith(INPUT.message, expect.objectContaining({
      abortSignal: signal,
      context: { snapshotId: 'snapshot-1', rendered: 'Prepared financial context' },
      onModelCall: expect.any(Function),
    }));
    expect(test.recordModelCall).toHaveBeenCalledTimes(1);
    expect(test.recordModelCall).toHaveBeenCalledWith({
      callId: 'call_turn-1',
      turnId: 'turn-1',
      subagent: 'conversation',
      provider: 'openai',
      model: 'runtime-model',
      providerId: 'logical-provider',
      modelId: 'vendor-model',
      adapterId: 'openai-adapter',
      protocol: 'responses',
      runtimeFingerprint: 'runtime-fingerprint',
      attempt: 1,
      inputTokens: 11,
      outputTokens: 7,
      cachedInputTokens: 3,
      totalTokens: 18,
      latencyMs: 37,
      finishReason: 'stop',
      cost: null,
      currency: null,
      contextSnapshotId: 'snapshot-1',
    });
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('omits context and records a null snapshot ID when preparation returns no context', async () => {
    const test = harness(null);

    await conversationRespondWorkflow(test.dependencies, INPUT);

    expect(test.respond.mock.calls[0]?.[1]?.context).toBeUndefined();
    expect(test.recordModelCall).toHaveBeenCalledWith(expect.objectContaining({ contextSnapshotId: null }));
  });

  it('does not call the agent or persist when context preparation fails', async () => {
    const test = harness();
    const failure = new Error('context unavailable');
    test.prepare.mockRejectedValue(failure);

    await expect(conversationRespondWorkflow(test.dependencies, INPUT)).rejects.toBe(failure);
    expect(test.respond).not.toHaveBeenCalled();
    expect(test.recordModelCall).not.toHaveBeenCalled();
  });

  it('does not persist metadata when the agent fails and propagates persistence failures', async () => {
    const failedAgent = harness();
    const modelFailure = new Error('model failed');
    failedAgent.respond.mockRejectedValue(modelFailure);
    await expect(conversationRespondWorkflow(failedAgent.dependencies, INPUT)).rejects.toBe(modelFailure);
    expect(failedAgent.recordModelCall).not.toHaveBeenCalled();

    const failedPersistence = harness();
    const persistenceFailure = new Error('store failed');
    failedPersistence.recordModelCall.mockRejectedValue(persistenceFailure);
    await expect(conversationRespondWorkflow(failedPersistence.dependencies, INPUT)).rejects.toBe(persistenceFailure);
  });

  it.each(['Who are you?', 'Saya ingin resep nasi'])('does not persist deterministic respond fast paths for %s', async message => {
    const test = harness();
    const { agent, llm } = realAgentForFastPaths();
    const dependencies = { ...test.dependencies, agent };

    await expect(conversationRespondWorkflow(dependencies, { ...INPUT, message })).resolves.toBeTruthy();

    expect(test.prepare).toHaveBeenCalledOnce();
    expect(llm.generateTextResult).not.toHaveBeenCalled();
    expect(test.recordModelCall).not.toHaveBeenCalled();
  });

  it('prepares once, forwards context and signal, and yields successful stream chunks unchanged in order', async () => {
    const test = harness();
    const signal = new AbortController().signal;
    const iterator = conversationStreamWorkflow(test.dependencies, { ...INPUT, signal });
    const first = await iterator[Symbol.asyncIterator]().next();
    expect(first).toEqual({ value: 'first', done: false });
    expect(test.recordModelCall).not.toHaveBeenCalled();

    const remaining = await collect(iterator);
    expect([first.value, ...remaining]).toEqual(['first', ' second']);
    expect(test.prepare).toHaveBeenCalledTimes(1);
    expect(test.prepare).toHaveBeenCalledWith({ sessionId: INPUT.sessionId, turnId: INPUT.turnId, message: INPUT.message });
    expect(test.stream).toHaveBeenCalledWith(INPUT.message, expect.objectContaining({
      abortSignal: signal,
      context: { snapshotId: 'snapshot-1', rendered: 'Prepared financial context' },
    }));
    expect(test.recordModelCall).toHaveBeenCalledTimes(1);
  });

  it('does not invoke or persist when stream context preparation fails', async () => {
    const test = harness();
    const failure = new Error('context unavailable');
    test.prepare.mockRejectedValue(failure);

    await expect(collect(conversationStreamWorkflow(test.dependencies, INPUT))).rejects.toBe(failure);
    expect(test.stream).not.toHaveBeenCalled();
    expect(test.recordModelCall).not.toHaveBeenCalled();
  });

  it.each(['Who are you?', 'Saya ingin resep nasi'])('does not persist deterministic stream fast paths for %s', async message => {
    const test = harness();
    const { agent, llm } = realAgentForFastPaths();

    expect(await collect(conversationStreamWorkflow({ ...test.dependencies, agent }, { ...INPUT, message }))).toHaveLength(1);

    expect(test.prepare).toHaveBeenCalledOnce();
    expect(llm.streamTextResult).not.toHaveBeenCalled();
    expect(test.recordModelCall).not.toHaveBeenCalled();
  });

  it('propagates incomplete stream failures without persisting successful metadata', async () => {
    const test = harness();
    const failure = new Error('stream interrupted');
    const llm = {
      generateTextResult: vi.fn(),
      streamTextResult: vi.fn(() => ({
        chunks: (async function* () { yield 'partial'; throw failure; })(),
        metadata: Promise.resolve(METADATA),
      })),
    } as unknown as Pick<LLMClientLike, 'generateTextResult' | 'streamTextResult'>;
    const realAgent = new MainFinHarnessAgent(llm);

    await expect(collect(conversationStreamWorkflow({ ...test.dependencies, agent: realAgent }, INPUT))).rejects.toBe(failure);
    expect(test.recordModelCall).not.toHaveBeenCalled();
  });

  it('propagates ModelCall persistence failure after a successful stream', async () => {
    const test = harness();
    const failure = new Error('store failed');
    test.recordModelCall.mockRejectedValue(failure);

    await expect(collect(conversationStreamWorkflow(test.dependencies, INPUT))).rejects.toBe(failure);
    expect(test.recordModelCall).toHaveBeenCalledOnce();
  });
});
