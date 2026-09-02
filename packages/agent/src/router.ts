import { IntentSchema, type Intent } from '@harness/schemas';
import type { LLMClientLike } from '@harness/llm';
import { INTENT_ROUTER_SYSTEM_PROMPT } from './prompts/router';

/** Ambang kepercayaan (addendum §20): di bawahnya → clarification. */
export const INTENT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Intent Router L1 (addendum §20/Task 13) — pure function:
 * klasifikasi natural language → command via LLM (tier ringan, §17).
 */
export class IntentRouter {
  constructor(private readonly llm: LLMClientLike) {}

  async route(input: string): Promise<Intent> {
    const intent = await this.llm.generateObject({
      schema: IntentSchema,
      system: INTENT_ROUTER_SYSTEM_PROMPT,
      prompt: input,
    });

    if (intent.type === 'clarification' || intent.confidence < INTENT_CONFIDENCE_THRESHOLD) {
      return {
        ...intent,
        type: 'clarification',
        question: intent.question ?? defaultClarificationQuestion(intent),
      };
    }
    return intent;
  }
}

function defaultClarificationQuestion(intent: Intent): string {
  return [
    'Do you mean:',
    `a) /judge ${intent.ticker ?? 'TICKER'}`,
    `b) /screen ${intent.criteria ?? 'CRITERIA'}`,
    'c) Something else?',
  ].join('\n');
}
