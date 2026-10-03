import { expect, it, vi } from 'vitest';
import { MAIN_KIRA_PROMPT, MainKiraAgent } from '../src/index';

it('states the human-only transaction authority rule in the system prompt', () => {
  expect(MAIN_KIRA_PROMPT).toMatch(/human.*transaction decision/i);
  expect(MAIN_KIRA_PROMPT).toMatch(/must not.*recommend.*buy.*sell.*hold/is);
});

it.each(['siapa kamu?', 'apa itu Kira?'])('answers identity locally without spending an LLM request (%s)', async (question) => {
  const llm = { generateText: vi.fn() };
  const agent = new MainKiraAgent(llm as never);
  const answer = await agent.respond(question);
  expect(answer).toContain('Saya Kira');
  expect(answer).not.toMatch(/\/research\b/);
  expect(llm.generateText).not.toHaveBeenCalled();
});

it('grounds general financial chat in a bounded main-agent prompt', async () => {
  const llm = {
    generateText: vi.fn(),
    generateTextResult: vi.fn().mockResolvedValue({
      value: 'Diversifikasi menyebarkan risiko. Coba /research untuk pembahasan berbukti.',
      metadata: { provider: 'mock', model: 'test', providerId: 'mock', modelId: 'test', adapterId: 'mock', protocol: 'mock', runtimeFingerprint: 'f'.repeat(64), inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, finishReason: 'stop', latencyMs: 0 },
    }),
  };
  const agent = new MainKiraAgent(llm as never);
  const answer = await agent.respond('apa itu diversifikasi?');
  expect(answer).toContain('Diversifikasi');
  expect(llm.generateTextResult).toHaveBeenCalledWith(expect.objectContaining({
    system: expect.stringMatching(/Main Kira Agent.*financial-only/s),
  }));
});

it.each([
  ['Should I buy BBCA?', /decision belongs to you/i],
  ['Buy or sell BBCA?', /decision belongs to you/i],
  ['Is BBCA a buy?', /decision belongs to you/i],
  ['Should I hold?', /decision belongs to you/i],
  ['Mending beli BBCA?', /keputusan.*milik Anda/i],
  ['Sebaiknya jual?', /keputusan.*milik Anda/i],
  ['Beli atau jual?', /keputusan.*milik Anda/i],
])('keeps transaction authority with the human without an LLM call (%s)', async (question, responsePattern) => {
  const llm = {
    generateTextResult: vi.fn().mockResolvedValue({ value: 'model answer', metadata: {} }),
    streamTextResult: vi.fn(),
  };
  const answer = await new MainKiraAgent(llm as never).respond(question);

  expect(answer).toMatch(responsePattern);
  expect(llm.generateTextResult).not.toHaveBeenCalled();
  expect(llm.streamTextResult).not.toHaveBeenCalled();
});

it('handles an Indonesian layak dibeli question locally without routing to /judge or the model', async () => {
  const question = 'Apakah BBRI layak dibeli?';
  const llm = { generateTextResult: vi.fn().mockResolvedValue({ value: 'model response', metadata: {} }), streamTextResult: vi.fn() };

  const answer = await new MainKiraAgent(llm as never).respond(question);

  expect(answer).toContain(question);
  expect(answer).toMatch(/keputusan transaksi tetap milik Anda/i);
  expect(llm.generateTextResult).not.toHaveBeenCalled();
});

it.each([
  'BBCA is a buy.',
  'You should not buy BBCA.',
  'I recommend that you buy BBCA.',
])('rejects a prohibited generated response after recording the external model call: %s', async (value) => {
  const metadata = { provider: 'mock', model: 'test', providerId: 'mock', modelId: 'test', adapterId: 'mock', protocol: 'mock', runtimeFingerprint: 'f'.repeat(64), inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, finishReason: 'stop', latencyMs: 0 };
  const onModelCall = vi.fn().mockResolvedValue(undefined);
  const llm = { generateTextResult: vi.fn().mockResolvedValue({ value, metadata }) };
  const agent = new MainKiraAgent(llm as never);

  await expect(agent.respond('What do the risks show?', { onModelCall })).rejects.toThrow(/transaction/i);
  expect(onModelCall).toHaveBeenCalledWith(metadata);
});

it.each([
  'I recommend allocating 20% to BBCA.',
  'You should place a limit order at 8,500.',
  'You should set a stop loss at 8,000.',
])('rejects Round 5 generated transaction advice after recording the model call: %s', async (value) => {
  const metadata = { provider: 'mock', model: 'test', providerId: 'mock', modelId: 'test', adapterId: 'mock', protocol: 'mock', runtimeFingerprint: 'f'.repeat(64), inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, finishReason: 'stop', latencyMs: 0 };
  const onModelCall = vi.fn().mockResolvedValue(undefined);
  const llm = { generateTextResult: vi.fn().mockResolvedValue({ value, metadata }) };

  await expect(new MainKiraAgent(llm as never).respond('What does the source recommend?', { onModelCall })).rejects.toThrow(/transaction/i);
  expect(onModelCall).toHaveBeenCalledWith(metadata);
});

it('allows generated external advice about order placement', async () => {
  const value = 'Broker X recommends placing a limit order at 8,500.';
  const metadata = { provider: 'mock', model: 'test', providerId: 'mock', modelId: 'test', adapterId: 'mock', protocol: 'mock', runtimeFingerprint: 'f'.repeat(64), inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, finishReason: 'stop', latencyMs: 0 };
  const llm = { generateTextResult: vi.fn().mockResolvedValue({ value, metadata }) };

  await expect(new MainKiraAgent(llm as never).respond('Summarize the broker note.')).resolves.toBe(value);
});

it('accepts generated analytical language that begins with a transaction-related term', async () => {
  const value = 'Exit multiples affect valuation and should be compared with sector peers.';
  const metadata = { provider: 'mock', model: 'test', providerId: 'mock', modelId: 'test', adapterId: 'mock', protocol: 'mock', runtimeFingerprint: 'f'.repeat(64), inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, finishReason: 'stop', latencyMs: 0 };
  const llm = { generateTextResult: vi.fn().mockResolvedValue({ value, metadata }) };

  await expect(new MainKiraAgent(llm as never).respond('Explain valuation multiples.')).resolves.toBe(value);
});

it('blocks a prohibited streamed directive across chunk boundaries and records metadata', async () => {
  const metadata = { provider: 'mock' as const, model: 'stream-model', providerId: 'mock', modelId: 'stream-model', adapterId: 'mock', protocol: 'mock', runtimeFingerprint: 'e'.repeat(64), inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, finishReason: 'stop', latencyMs: 0 };
  const onModelCall = vi.fn().mockResolvedValue(undefined);
  const llm = {
    streamTextResult: vi.fn(() => ({
      chunks: (async function* () { yield 'I recommend '; yield 'buying BBCA.'; yield ' More detail.'; })(),
      metadata: Promise.resolve(metadata),
    })),
  };
  const agent = new MainKiraAgent(llm as never);
  const exposed: string[] = [];

  await expect((async () => {
    for await (const chunk of agent.stream('Analyze the evidence.', { onModelCall })) exposed.push(chunk);
  })()).rejects.toThrow(/transaction/i);
  expect(exposed).toEqual(['I recommend ']);
  expect(onModelCall).toHaveBeenCalledWith(metadata);
});

it('passes stable structured context to the model and records the call after success', async () => {
  const onModelCall = vi.fn().mockResolvedValue(undefined);
  const metadata = {
    provider: 'openai' as const, model: 'gpt-test', providerId: 'openai', modelId: 'gpt-test',
    adapterId: 'openai-compatible', protocol: 'openai-chat', runtimeFingerprint: 'f'.repeat(64),
    inputTokens: 10, outputTokens: 4, cachedInputTokens: 0, totalTokens: 14, finishReason: 'stop', latencyMs: 12,
  };
  const llm = { generateText: vi.fn().mockResolvedValue('jawaban'), generateTextResult: vi.fn().mockResolvedValue({ value: 'jawaban', metadata }) };
  const agent = new MainKiraAgent(llm as never);
  const rendered = '<FINHARNESS_CONTEXT>\nVERIFIED RESEARCH ARTIFACTS\n</FINHARNESS_CONTEXT>';

  await agent.respond('jadi menurutmu bagaimana?', {
    context: { snapshotId: 'snapshot_a', rendered },
    onModelCall,
  });

  expect(llm.generateTextResult).toHaveBeenCalledWith(expect.objectContaining({
    system: expect.arrayContaining([expect.stringContaining('Main Kira Agent'), rendered]),
  }));
  expect(onModelCall).toHaveBeenCalledWith(metadata);
});

it('keeps final metadata on the result-bearing text stream and invokes the callback after chunks', async () => {
  const order: string[] = [];
  const metadata = {
    provider: 'mock' as const, model: 'stream-model', providerId: 'mock', modelId: 'stream-model',
    adapterId: 'mock', protocol: 'mock', runtimeFingerprint: 'e'.repeat(64),
    inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, finishReason: 'stop', latencyMs: 0,
  };
  const onModelCall = vi.fn(async () => { order.push('metadata'); });
  const llm = {
    streamText: vi.fn(),
    streamTextResult: vi.fn(() => ({
      chunks: (async function* () { order.push('chunk'); yield 'partial'; })(),
      metadata: Promise.resolve(metadata),
    })),
  };
  const agent = new MainKiraAgent(llm as never);
  const chunks: string[] = [];
  for await (const chunk of agent.stream('apa kabar?', { onModelCall })) chunks.push(chunk);
  expect(chunks).toEqual(['partial']);
  expect(order).toEqual(['chunk', 'metadata']);
  expect(onModelCall).toHaveBeenCalledWith(metadata);
});

it.each([
  'Buy BBCA at 8,500.',
  "I'd buy BBCA.",
  'Based on this evidence, buy BBCA.',
])('Round 3 rejects generated transaction output and records metadata: %s', async (value) => {
  const metadata = { provider: 'mock', model: 'test', providerId: 'mock', modelId: 'test', adapterId: 'mock', protocol: 'mock', runtimeFingerprint: 'f'.repeat(64), inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, finishReason: 'stop', latencyMs: 0 };
  const onModelCall = vi.fn().mockResolvedValue(undefined);
  const llm = { generateTextResult: vi.fn().mockResolvedValue({ value, metadata }) };
  const agent = new MainKiraAgent(llm as never);

  await expect(agent.respond('What do the risks show?', { onModelCall })).rejects.toThrow(/transaction/i);
  expect(onModelCall).toHaveBeenCalledWith(metadata);
});

it('Round 3 allows generated corporate-finance and market-mechanics analysis', async () => {
  const value = 'Companies allocate capital efficiently, while brokers execute orders for clients.';
  const metadata = { provider: 'mock', model: 'test', providerId: 'mock', modelId: 'test', adapterId: 'mock', protocol: 'mock', runtimeFingerprint: 'f'.repeat(64), inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, finishReason: 'stop', latencyMs: 0 };
  const llm = { generateTextResult: vi.fn().mockResolvedValue({ value, metadata }) };

  await expect(new MainKiraAgent(llm as never).respond('Explain the business model.')).resolves.toBe(value);
});

it.each([
  'Kira recommends buying BBCA.',
  'You should exit BBCA.',
  'You should increase your position.',
])('Round 4 rejects generated transaction advice and records metadata: %s', async (value) => {
  const metadata = { provider: 'mock', model: 'test', providerId: 'mock', modelId: 'test', adapterId: 'mock', protocol: 'mock', runtimeFingerprint: 'f'.repeat(64), inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, finishReason: 'stop', latencyMs: 0 };
  const onModelCall = vi.fn().mockResolvedValue(undefined);
  const llm = { generateTextResult: vi.fn().mockResolvedValue({ value, metadata }) };
  const agent = new MainKiraAgent(llm as never);

  await expect(agent.respond('What do the risks show?', { onModelCall })).rejects.toThrow(/transaction/i);
  expect(onModelCall).toHaveBeenCalledWith(metadata);
});

it('Round 4 allows a clearly attributed external recommendation', async () => {
  const value = 'Broker X recommends buying BBCA, while the evidence remains mixed.';
  const metadata = { provider: 'mock', model: 'test', providerId: 'mock', modelId: 'test', adapterId: 'mock', protocol: 'mock', runtimeFingerprint: 'f'.repeat(64), inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, finishReason: 'stop', latencyMs: 0 };
  const llm = { generateTextResult: vi.fn().mockResolvedValue({ value, metadata }) };

  await expect(new MainKiraAgent(llm as never).respond('Summarize the analyst note.')).resolves.toBe(value);
});
