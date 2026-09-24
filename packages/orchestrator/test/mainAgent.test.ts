import { expect, it, vi } from 'vitest';
import { MainFinHarnessAgent } from '../src/index';

it.each(['siapa kamu?', 'apa itu Kira?'])('answers identity locally without spending an LLM request (%s)', async (question) => {
  const llm = { generateText: vi.fn() };
  const agent = new MainFinHarnessAgent(llm as never);
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
  const agent = new MainFinHarnessAgent(llm as never);
  const answer = await agent.respond('apa itu diversifikasi?');
  expect(answer).toContain('Diversifikasi');
  expect(llm.generateTextResult).toHaveBeenCalledWith(expect.objectContaining({
    system: expect.stringMatching(/Main Kira Agent.*financial-only/s),
  }));
});

it('passes stable structured context to the model and records the call after success', async () => {
  const onModelCall = vi.fn().mockResolvedValue(undefined);
  const metadata = {
    provider: 'openai' as const, model: 'gpt-test', providerId: 'openai', modelId: 'gpt-test',
    adapterId: 'openai-compatible', protocol: 'openai-chat', runtimeFingerprint: 'f'.repeat(64),
    inputTokens: 10, outputTokens: 4, cachedInputTokens: 0, totalTokens: 14, finishReason: 'stop', latencyMs: 12,
  };
  const llm = { generateText: vi.fn().mockResolvedValue('jawaban'), generateTextResult: vi.fn().mockResolvedValue({ value: 'jawaban', metadata }) };
  const agent = new MainFinHarnessAgent(llm as never);
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
  const agent = new MainFinHarnessAgent(llm as never);
  const chunks: string[] = [];
  for await (const chunk of agent.stream('apa kabar?', { onModelCall })) chunks.push(chunk);
  expect(chunks).toEqual(['partial']);
  expect(order).toEqual(['chunk', 'metadata']);
  expect(onModelCall).toHaveBeenCalledWith(metadata);
});
