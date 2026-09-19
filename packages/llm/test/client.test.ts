import { createServer, type Server } from 'node:http';
import { APICallError } from 'ai';
import { MockLanguageModelV2 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_AGENT_CONFIG, LLMClient, classifyLLMError, createProvider, parseJsonResponse, toSystemPrompt } from '../src/index';

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
  it('validates a fenced custom-provider JSON reply locally', () => {
    expect(parseJsonResponse('```json\n{"answer":"ok","score":7}\n```', OBJECT_SCHEMA))
      .toEqual({ answer: 'ok', score: 7 });
    expect(() => parseJsonResponse('{"answer":"bad","score":"7"}', OBJECT_SCHEMA)).toThrow();
  });
  it('keeps truthful Responses session affinity stable and uses streaming with cache metadata', async () => {
    const requests: Array<{ headers: Headers; body: any }> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      requests.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return new Response('{"error":{"message":"unauthorized"}}', { status: 401 });
    });
    try {
      const client = new LLMClient({ config: { ...DEFAULT_AGENT_CONFIG, api: 'responses', baseURL: 'https://gateway.test/v1', apiKey: 'test-key' }, maxRetries: 1 });
      for (let i = 0; i < 2; i++) await expect(client.generateText({ prompt: 'OK' })).rejects.toBeDefined();
      expect(requests).toHaveLength(2);
      const id = requests[0].headers.get('session_id');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(requests[1].headers.get('session_id')).toBe(id);
      expect(requests[0].headers.get('user-agent')).toContain('finharness');
      expect(requests[0].body).toMatchObject({ stream: true, store: false, prompt_cache_key: id });
    } finally { vi.unstubAllGlobals(); }
  });
  it('preserves a streaming provider failure instead of an empty-object wrapper', async () => {
    const failure = new APICallError({ message: 'insufficient balance', statusCode: 402, url: 'https://example.test', requestBodyValues: {} });
    const model = new MockLanguageModelV2({ doStream: async () => { throw failure; } });
    const client = new LLMClient({ config: DEFAULT_AGENT_CONFIG, maxRetries: 1, modelFactory: () => model });
    await expect(client.streamObject({ schema: OBJECT_SCHEMA, prompt: 'test' })).rejects.toBe(failure);
  });
  it('aborts text checks without retrying or falling back', async () => {
    const controller = new AbortController();
    let calls = 0;
    const model = new MockLanguageModelV2({ doGenerate: async (options) => {
      calls++;
      controller.abort();
      options.abortSignal?.throwIfAborted();
      return resultOf('unexpected');
    } });
    const client = new LLMClient({ config: DEFAULT_AGENT_CONFIG, modelFactory: () => model,
      fallbackConfigs: [DEFAULT_AGENT_CONFIG], retryBaseDelayMs: 1 });
    await expect(client.generateText({ prompt: 'ping', abortSignal: controller.signal })).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('validates JSON against the schema even when native structured output is unsupported', async () => {
    let calls = 0;
    const model = new MockLanguageModelV2({ doGenerate: async () => {
      calls++;
      if (calls === 1) throw new APICallError({ message: 'response_format json_schema unsupported', url: 'https://test/chat', requestBodyValues: {}, statusCode: 400 });
      return resultOf({ answer: 'x', score: 'not a number' });
    } });
    const client = new LLMClient({ config: DEFAULT_AGENT_CONFIG, modelFactory: () => model });
    await expect(client.generateObject({ schema: OBJECT_SCHEMA, prompt: 'p' })).rejects.toThrow();
  });
  it('generateObject returns the schema-parsed object', async () => {
    const client = new LLMClient({
      config: DEFAULT_AGENT_CONFIG,
      modelFactory: () => jsonModel({ answer: 'hello', score: 72 }),
    });
    const result = await client.generateObject({ schema: OBJECT_SCHEMA, prompt: 'p', system: 's' });
    expect(result).toEqual({ answer: 'hello', score: 72 });
  });

  it('generateObjectResult returns the parsed value with provider usage metadata', async () => {
    const config = { ...DEFAULT_AGENT_CONFIG, model: 'usage-model' };
    const client = new LLMClient({
      config,
      modelFactory: () => jsonModel({ answer: 'hello', score: 72 }),
    });

    const result = await client.generateObjectResult({ schema: OBJECT_SCHEMA, prompt: 'p' });

    expect(result.value).toEqual({ answer: 'hello', score: 72 });
    expect(result.metadata).toEqual(expect.objectContaining({
      provider: config.provider,
      model: 'usage-model',
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: null,
      totalTokens: 15,
      finishReason: 'stop',
      latencyMs: expect.any(Number),
      providerId: 'openai',
      modelId: 'usage-model',
      adapterId: 'openai-compatible',
      protocol: 'openai-chat',
      runtimeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it('generateTextResult reports the prepared runtime identity and actual usage', async () => {
    const config = { ...DEFAULT_AGENT_CONFIG, model: 'text-runtime-model' };
    const client = new LLMClient({ config, modelFactory: () => textModel('plain text') });
    const result = await client.generateTextResult({ prompt: 'p' });
    expect(result.value).toBe('plain text');
    expect(result.metadata).toEqual(expect.objectContaining({
      provider: 'openai',
      model: 'text-runtime-model',
      providerId: 'openai',
      modelId: 'text-runtime-model',
      adapterId: 'openai-compatible',
      protocol: 'openai-chat',
      runtimeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      inputTokens: 10,
      outputTokens: 5,
    }));
  });

  it('reports the fallback prepared route that actually succeeds', async () => {
    const primary = new MockLanguageModelV2({ doGenerate: async () => { throw retryableError('RATE_LIMIT', 'primary unavailable'); } });
    const fallback = jsonModel({ answer: 'fallback', score: 9 });
    const models = [primary, fallback];
    const client = new LLMClient({
      config: { ...DEFAULT_AGENT_CONFIG, model: 'primary-model' },
      fallbackConfigs: [{ ...DEFAULT_AGENT_CONFIG, provider: 'anthropic', model: 'fallback-model' }],
      maxRetries: 1,
      modelFactory: () => models.shift()!,
      retryBaseDelayMs: 1,
    });
    const result = await client.generateObjectResult({ schema: OBJECT_SCHEMA, prompt: 'p' });
    expect(result.value).toEqual({ answer: 'fallback', score: 9 });
    expect(result.metadata).toEqual(expect.objectContaining({
      provider: 'anthropic',
      model: 'fallback-model',
      providerId: 'anthropic#fallback-1',
      modelId: 'fallback-model',
      adapterId: 'anthropic',
      protocol: 'anthropic-messages',
    }));
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

describe('createProvider (custom endpoint, OpenAI-compatible)', () => {
  const base = { provider: 'openai' as const, model: 'm', temperature: 0, maxTokens: 10 };

  it('selects the OpenAI provider for provider=openai', () => {
    const provider = createProvider(base);
    expect('responses' in provider).toBe(true);
    expect('chat' in provider).toBe(true);
  });

  it('selects the Anthropic provider for provider=anthropic', () => {
    const provider = createProvider({ ...base, provider: 'anthropic' });
    expect('tools' in provider).toBe(true);
    expect('messages' in provider).toBe(true);
  });
});

describe('custom endpoint round-trip (fake OpenAI-compatible server)', () => {
  /** Fake server OpenAI-compatible — endpoint /chat/completions, respons JSON (non-stream). */
  function startFakeOpenAI() {
    const seen: Array<{ path?: string; authorization?: string; body?: unknown }> = [];
    const server: Server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          body = undefined;
        }
        seen.push({ path: req.url, authorization: req.headers.authorization, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 1,
            model: 'fake-model',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'halo dari fake provider' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        );
      });
    });
    return new Promise<{ url: string; seen: typeof seen; close: () => Promise<void> }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        resolve({
          url: `http://127.0.0.1:${port}/v1`,
          seen,
          close: () =>
            new Promise<void>((done, fail) => {
              server.closeAllConnections?.();
              server.close((err) => (err ? fail(err) : done()));
            }),
        });
      });
    });
  }

  it('LLMClient benar-benar mengirim request ke baseURL kustom dan mem-parse SSE', async () => {
    const fake = await startFakeOpenAI();
    try {
      const client = new LLMClient({
        config: {
          provider: 'openai',
          model: 'fake-model',
          temperature: 0,
          maxTokens: 100,
          baseURL: fake.url,
          apiKey: 'test-key',
        },
      });
      const text = await client.generateText({ prompt: 'hi' });
      expect(text).toBe('halo dari fake provider');
      expect(fake.seen).toHaveLength(1);
      expect(fake.seen[0].path).toBe('/v1/chat/completions');
      expect(fake.seen[0].authorization).toBe('Bearer test-key');
      const body = fake.seen[0].body as {
        model?: string;
        messages?: Array<{ role?: string; content?: string }>;
      };
      expect(body.model).toBe('fake-model');
      expect(body.messages?.some((m) => m.content === 'hi')).toBe(true);
    } finally {
      await fake.close();
    }
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
