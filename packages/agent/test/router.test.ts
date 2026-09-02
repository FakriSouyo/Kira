import { describe, expect, it } from 'vitest';
import { INTENT_CONFIDENCE_THRESHOLD, IntentRouter } from '../src/index';
import { fakeLLM, SAMPLE_INTENT } from './fakes';

describe('IntentRouter', () => {
  it('passes through high-confidence intents', async () => {
    const { llm } = fakeLLM(SAMPLE_INTENT);
    const router = new IntentRouter(llm);

    const intent = await router.route('Apakah BBCA layak dibeli?');
    expect(intent).toEqual(SAMPLE_INTENT);
  });

  it('downgrades low-confidence intents to clarification', async () => {
    const { llm } = fakeLLM({ type: 'judge', confidence: 0.5, ticker: 'BBCA' });
    const router = new IntentRouter(llm);

    const intent = await router.route('maybe something about BBCA');
    expect(intent.type).toBe('clarification');
    expect(intent.question).toContain('/judge BBCA');
  });

  it('adds a default question when the LLM returns clarification without one', async () => {
    const { llm } = fakeLLM({ type: 'clarification', confidence: 0.4 });
    const router = new IntentRouter(llm);

    const intent = await router.route('hmm');
    expect(intent.type).toBe('clarification');
    expect(intent.question).toMatch(/Do you mean:/);
  });

  it('threshold constant matches the spec (0.7)', () => {
    expect(INTENT_CONFIDENCE_THRESHOLD).toBe(0.7);
  });
});
