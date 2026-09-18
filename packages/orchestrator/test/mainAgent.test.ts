import { expect, it, vi } from 'vitest';
import { MainFinHarnessAgent } from '../src/index';

it('answers identity locally without spending an LLM request', async () => {
  const llm = { generateText: vi.fn() };
  const agent = new MainFinHarnessAgent(llm as never);
  const answer = await agent.respond('siapa kamu?');
  expect(answer).toContain('Saya FinHarness');
  expect(llm.generateText).not.toHaveBeenCalled();
});

it('grounds general financial chat in a bounded main-agent prompt', async () => {
  const llm = { generateText: vi.fn().mockResolvedValue('Diversifikasi menyebarkan risiko. Coba /research untuk pembahasan berbukti.') };
  const agent = new MainFinHarnessAgent(llm as never);
  const answer = await agent.respond('apa itu diversifikasi?');
  expect(answer).toContain('Diversifikasi');
  expect(llm.generateText).toHaveBeenCalledWith(expect.objectContaining({
    system: expect.stringMatching(/Main FinHarness Agent.*financial-only/s),
  }));
});

it('passes stable structured context to the model and records the call after success', async () => {
  const onModelCall = vi.fn().mockResolvedValue(undefined);
  const llm = { generateText: vi.fn().mockResolvedValue('jawaban') };
  const agent = new MainFinHarnessAgent(llm as never);
  const rendered = '<FINHARNESS_CONTEXT>\nVERIFIED RESEARCH ARTIFACTS\n</FINHARNESS_CONTEXT>';

  await agent.respond('jadi menurutmu bagaimana?', {
    context: { snapshotId: 'snapshot_a', rendered },
    onModelCall,
  });

  expect(llm.generateText).toHaveBeenCalledWith(expect.objectContaining({
    system: expect.arrayContaining([expect.stringContaining('Main FinHarness Agent'), rendered]),
  }));
  expect(onModelCall).toHaveBeenCalledTimes(1);
});
