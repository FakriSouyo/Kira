import type { LLMClientLike } from '@harness/llm';
import { IntentSchema, type Intent } from '@harness/schemas';

export const INTENT_CONFIDENCE_THRESHOLD = 0.7;
export const INTENT_ROUTER_SYSTEM_PROMPT = `You are Intent Router for Kira.

Classify user input as judge, screen, challenge, compare, or clarification.
Return confidence from 0 to 1. If intent is ambiguous, return clarification with a useful question.`;

export class IntentRouter {
  constructor(private readonly llm: Pick<LLMClientLike, 'generateObject'>) {}

  async route(input: string): Promise<Intent> {
    const intent = await this.llm.generateObject({ schema: IntentSchema, system: INTENT_ROUTER_SYSTEM_PROMPT, prompt: input });
    if (intent.type !== 'clarification' && intent.confidence >= INTENT_CONFIDENCE_THRESHOLD) return intent;
    return { ...intent, type: 'clarification', question: intent.question ?? defaultQuestion(intent) };
  }
}

function defaultQuestion(intent: Intent): string {
  return ['Do you mean:', `a) /judge ${intent.ticker ?? 'TICKER'}`, `b) /screen ${intent.criteria ?? 'CRITERIA'}`, 'c) Something else?'].join('\n');
}
