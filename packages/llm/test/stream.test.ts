import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { LLMClient, MockLLMClient } from '../src/index';

/**
 * Test streaming jalur text (Phase 2 Task 2):
 *   - LLMClient.streamText → Vercel `streamText`, textStream (tanpa withRetry).
 *   - MockLLMClient.streamText → AsyncIterable deterministik (3 chunk).
 * Klaim & judgment TETAP via generateObject (dua jalur, lihat ARCHITECTURE Deviasi #21).
 *
 * LLMClient.streamText diuji lewat fake OpenAI server yang mengirim SSE delta
 * (gaya sama dgn `custom endpoint round-trip` di client.test.ts, tapi streaming).
 */

/** Fake OpenAI-compatible server dengan streaming SSE chat completions. */
function startFakeOpenAIStream(chunks: string[]) {
  const seen: Array<{ path?: string; authorization?: string }> = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ path: req.url, authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Bentuk satu respons streaming chat.completion.chunk per delta.
      for (const content of chunks) {
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fake-model',
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`,
        );
      }
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fake-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
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

describe('LLMClient.streamText (Phase 2 Task 2)', () => {
  it('streams text dari endpoint kustom (SSE delta) sebagai AsyncIterable', async () => {
    const chunks = ['[stream] ', 'hello ', 'world!'];
    const fake = await startFakeOpenAIStream(chunks);
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
      const xs: string[] = [];
      for await (const c of client.streamText({ prompt: 'hi' })) xs.push(c);
      expect(xs.join('')).toBe('[stream] hello world!');
      // ASCII: streaming berlangsung (lebih dari 1 yield) — bukan generateText non-stream
      expect(xs.length).toBeGreaterThan(1);
      expect(fake.seen).toHaveLength(1);
      expect(fake.seen[0].path).toBe('/v1/chat/completions');
      expect(fake.seen[0].authorization).toBe('Bearer test-key');
    } finally {
      await fake.close();
    }
  });

  it('exposes final metadata from the same prepared stream route', async () => {
    const fake = await startFakeOpenAIStream(['one', 'two']);
    try {
      const client = new LLMClient({
        config: {
          provider: 'openai', model: 'stream-metadata-model', temperature: 0, maxTokens: 100,
          baseURL: fake.url, apiKey: 'test-key',
        },
      });
      const stream = client.streamTextResult({ prompt: 'hi' });
      const chunks: string[] = [];
      for await (const chunk of stream.chunks) chunks.push(chunk);
      const metadata = await stream.metadata;
      expect(chunks.join('')).toBe('onetwo');
      expect(metadata).toEqual(expect.objectContaining({
        providerId: 'openai', modelId: 'stream-metadata-model', adapterId: 'openai-compatible',
        protocol: 'openai-chat', runtimeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }));
    } finally {
      await fake.close();
    }
  });
});

describe('MockLLMClient.streamText (Phase 2 Task 2)', () => {
  const mock = new MockLLMClient();

  it('men yield 3 chunk deterministik tanpa delay', async () => {
    const prompt = 'x'.repeat(80);
    const xs: string[] = [];
    for await (const c of mock.streamText({ prompt })) xs.push(c);
    expect(xs).toEqual(['[mock-llm] ', 'x'.repeat(40), 'x'.repeat(40)]);
  });

  it('konsisten lintas panggilan (deterministik untuk test)', async () => {
    const collect = async (p: string) => {
      const out: string[] = [];
      for await (const c of mock.streamText({ prompt: p })) out.push(c);
      return out;
    };
    expect(await collect('y'.repeat(90))).toEqual(await collect('y'.repeat(90)));
  });
});
