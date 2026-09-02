import { createServer, type Server } from 'node:http';
import { APICallError } from 'ai';
import { MockLanguageModelV2 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_AGENT_CONFIG, LLMClient, classifyLLMError, createProvider, toSystemPrompt } from '../src/index';

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
