import { APICallError } from 'ai';
import { MockLanguageModelV2 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_AGENT_CONFIG, LLMClient, classifyLLMError, toSystemPrompt } from '../src/index';

const OBJECT_SCHEMA = z.object({ answer: z.string(), score: z.number() });

function resultOf(payload: unknown | string) {
  return {
    content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    finishReason: 'stop' as const,
    warnings: [],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

/** Error retryable di lapisan LLMClient (addendum §21) — bukan APICallError,
 *  karena AI SDK sudah mem-retry APICallError 429/5xx secara internal. */
function retryableError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function jsonModel(payload: unknown, onCall?: (callIndex: number) => void): MockLanguageModelV2 {
  let calls = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => {
      onCall?.(calls);
      calls += 1;
      return resultOf(payload);
    },
  });
}

function textModel(text: string): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    doGenerate: async () => resultOf(text),
  });
}

describe('LLMClient', () => {
  it('generateObject returns the schema-parsed object', async () => {
    const client = new LLMClient({
      config: DEFAULT_AGENT_CONFIG,
      modelFactory: () => jsonModel({ answer: 'hello', score: 72 }),
    });
    const result = await client.generateObject({ schema: OBJECT_SCHEMA, prompt: 'p', system: 's' });
    expect(result).toEqual({ answer: 'hello', score: 72 });
  });

  it('generateText returns the model text', async () => {
    const client = new LLMClient({ config: DEFAULT_AGENT_CONFIG, modelFactory: () => textModel('plain text') });
    expect(await client.generateText({ prompt: 'p' })).toBe('plain text');
  });

  it('passes temperature & maxTokens from the two-tier config to the model', async () => {
    const config = { provider: 'openai' as const, model: 'test', temperature: 0.2, maxTokens: 2000 };
    let seen: { temperature?: number; maxOutputTokens?: number } = {};
    const model = new MockLanguageModelV2({
      doGenerate: async (options) => {
        seen = options as { temperature?: number; maxOutputTokens?: number };
        return resultOf({ answer: 'x', score: 1 });
      },
    });
    const client = new LLMClient({ config, modelFactory: () => model });
    await client.generateObject({ schema: OBJECT_SCHEMA, prompt: 'p' });
    expect(seen.temperature).toBe(0.2);
    // maxTokens (config) diteruskan sebagai maxOutputTokens (LanguageModel V2)
    expect(seen.maxOutputTokens).toBe(2000);
  });

  it('retries on retryable code with backoff, then succeeds', async () => {
    const calls: number[] = [];
    const flaky = new MockLanguageModelV2({
      doGenerate: async () => {
        calls.push(calls.length);
        if (calls.length < 2) {
          throw retryableError('RATE_LIMIT', 'rate limited');
        }
        return resultOf({ answer: 'ok', score: 10 });
      },
    });
    const client = new LLMClient({
      config: DEFAULT_AGENT_CONFIG,
      modelFactory: () => flaky,
      maxRetries: 3,
      retryBaseDelayMs: 1,
    });
    const result = await client.generateObject({ schema: OBJECT_SCHEMA, prompt: 'p' });
    expect(result).toEqual({ answer: 'ok', score: 10 });
    expect(calls).toHaveLength(2);
  });

  it('does not retry non-retryable errors (400)', async () => {
    let calls = 0;
    const bad = new MockLanguageModelV2({
      doGenerate: async () => {
        calls += 1;
        throw new APICallError({ message: 'bad request', url: 'https://test/v1/chat', requestBodyValues: {}, statusCode: 400 });
      },
    });
    const client = new LLMClient({
      config: DEFAULT_AGENT_CONFIG,
      modelFactory: () => bad,
      maxRetries: 3,
      retryBaseDelayMs: 1,
    });
    await expect(client.generateObject({ schema: OBJECT_SCHEMA, prompt: 'p' })).rejects.toThrow(APICallError);
    expect(calls).toBe(1);
  });

  it('gives up after maxRetries on persistent failure', async () => {
    let calls = 0;
    const broken = new MockLanguageModelV2({
      doGenerate: async () => {
        calls += 1;
        throw retryableError('SERVER_ERROR', 'server error');
      },
    });
    const client = new LLMClient({
      config: DEFAULT_AGENT_CONFIG,
      modelFactory: () => broken,
      maxRetries: 3,
      retryBaseDelayMs: 1,
    });
    await expect(client.generateObject({ schema: OBJECT_SCHEMA, prompt: 'p' })).rejects.toThrow('server error');
    expect(calls).toBe(3);
  });
});

describe('classifyLLMError', () => {
  it('maps status codes to retryable codes', () => {
    const mk = (status: number) =>
      new APICallError({ message: 'x', url: 'https://t', requestBodyValues: {}, statusCode: status });
    expect(classifyLLMError(mk(429))).toEqual({ code: 'RATE_LIMIT', retryable: true });
    expect(classifyLLMError(mk(500)).retryable).toBe(true);
    expect(classifyLLMError(mk(503)).code).toBe('SERVER_ERROR');
    expect(classifyLLMError(mk(408))).toEqual({ code: 'TIMEOUT', retryable: true });
    expect(classifyLLMError(mk(400)).retryable).toBe(false);
    expect(classifyLLMError(new Error('boom')).retryable).toBe(false);
    expect(classifyLLMError(Object.assign(new Error('t'), { code: 'TIMEOUT' })).retryable).toBe(true);
  });
});

describe('toSystemPrompt (cache zones, addendum §17)', () => {
  it('returns a plain string for single-zone prompts', () => {
    expect(toSystemPrompt('solo', 'openai')).toBe('solo');
    expect(toSystemPrompt(undefined, 'openai')).toBeUndefined();
  });

  it('keeps zone order in the joined prompt (prefix = zona [1], cache-friendly)', () => {
    expect(toSystemPrompt(['zone1', 'zone2'], 'openai')).toBe('zone1\nzone2');
  });

  it('joins zones identically for anthropic (breakpoint cache_control menunggu upgrade AI SDK)', () => {
    expect(toSystemPrompt(['zone1', 'zone2'], 'anthropic')).toBe('zone1\nzone2');
  });
});
