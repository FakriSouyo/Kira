import { describe, expect, it } from 'vitest';
import type { GenerateObjectParams, LLMClientLike } from '@harness/llm';
import { IntentRouter } from '../src/index.js';

class FixedLLM implements LLMClientLike {
  constructor(private readonly output: unknown) {}
  async generateObject<T>(params: GenerateObjectParams<T>): Promise<T> { return params.schema.parse(this.output); }
  async streamObject<T>(): Promise<T> { throw new Error('not used'); }
  async generateText(): Promise<string> { throw new Error('not used'); }
  streamText(): AsyncIterable<string> { throw new Error('not used'); }
}

describe('IntentRouter package', () => {
  it('passes through a high-confidence command intent', async () => {
    await expect(new IntentRouter(new FixedLLM({ type: 'judge', confidence: 0.9, ticker: 'BBCA' }))
      .route('Apakah BBCA layak dibeli?')).resolves.toEqual({ type: 'judge', confidence: 0.9, ticker: 'BBCA' });
  });
  it('turns a low-confidence intent into clarification', async () => {
    const intent = await new IntentRouter(new FixedLLM({ type: 'judge', confidence: 0.5, ticker: 'BBCA' })).route('maybe BBCA');
    expect(intent).toMatchObject({ type: 'clarification' });
    expect(intent.question).toContain('/judge BBCA');
  });
});
