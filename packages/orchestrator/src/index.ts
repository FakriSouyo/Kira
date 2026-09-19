import type { LLMCallMetadata, LLMClientLike } from '@harness/llm';

export * from './conversationContext.js';

export const MAIN_FINHARNESS_PROMPT = `Main FinHarness Agent — financial-only conversational host.
You explain financial concepts, discuss investment reasoning, and help the user choose the right evidence workflow.
You are not a market-data source and must not invent current prices, filings, news, or company facts.
For claims requiring fresh evidence, recommend exactly one relevant command: /research, /judge, /compare, /challenge, /investigate, /screen, or /search.
For unrelated topics, briefly explain that FinHarness is limited to finance and invite a financial question.
Reply in the user's language, concisely. Never claim to be a specialist subagent.`;

const IDENTITY = /^(siapa kamu|kamu siapa|who are you|what are you|apa itu finharness|kenalkan diri)[\s?!.,]*$/i;
const CLEARLY_OFF_TOPIC = /\b(resep|masak|cuaca|sepak bola|football|film|musik|game|coding|programming|puisi|cerita fiksi)\b/i;

const IDENTITY_ANSWER = 'Saya FinHarness, agent riset finansial yang membantu menjelaskan konsep, menata pertanyaan, dan menjalankan workflow berbasis evidence. Untuk analisis perusahaan gunakan /judge [TICKER], atau mulai riset umum dengan /research [QUESTION].';
const OFF_TOPIC_ANSWER = 'Saya hanya membantu topik finansial, investasi, perusahaan, pasar, dan riset berbasis evidence. Silakan ajukan pertanyaan finansial atau tekan Ctrl+P untuk memilih workflow.';

export function buildMainAgentPrompt(question: string): string {
  return `User question: ${question}\nAnswer as the bounded FinHarness financial assistant.`;
}

export interface MainAgentContext {
  readonly snapshotId: string;
  readonly rendered: string;
}

export interface MainAgentCallOptions {
  readonly abortSignal?: AbortSignal;
  readonly context?: MainAgentContext;
  /** Called only after an external model call succeeds. */
  readonly onModelCall?: (metadata: LLMCallMetadata) => Promise<void>;
}

function systemPrompt(context?: MainAgentContext): string | string[] {
  return context ? [MAIN_FINHARNESS_PROMPT, context.rendered] : MAIN_FINHARNESS_PROMPT;
}

/** Conversational host. Commands still own workflows and selectively invoke specialist subagents. */
export class MainFinHarnessAgent {
  constructor(private readonly llm: Pick<LLMClientLike, 'generateText' | 'streamText' | 'generateTextResult' | 'streamTextResult'>) {}

  async respond(input: string, options: MainAgentCallOptions = {}): Promise<string> {
    const question = input.trim();
    if (IDENTITY.test(question)) {
      return IDENTITY_ANSWER;
    }
    if (CLEARLY_OFF_TOPIC.test(question)) {
      return OFF_TOPIC_ANSWER;
    }
    const params = {
      system: systemPrompt(options.context),
      prompt: buildMainAgentPrompt(question),
      abortSignal: options.abortSignal,
    };
    const result = this.llm.generateTextResult
      ? await this.llm.generateTextResult(params)
      : { value: await this.llm.generateText(params), metadata: undefined };
    if (result.metadata) await options.onModelCall?.(result.metadata);
    return result.value;
  }

  /**
   * Variant streaming untuk transcript percakapan (Audit doc D1/D2):
   * kembalikan AsyncIterable<string> token-per-token. Fast-path identitas/
   * off-topic menghasilkan jawaban kanonik sekali; sisanya dialirkan dari LLM.
   */
  async *stream(input: string, options: MainAgentCallOptions = {}): AsyncIterable<string> {
    const question = input.trim();
    if (IDENTITY.test(question)) {
      yield IDENTITY_ANSWER;
      return;
    }
    if (CLEARLY_OFF_TOPIC.test(question)) {
      yield OFF_TOPIC_ANSWER;
      return;
    }
    const params = { system: systemPrompt(options.context), prompt: buildMainAgentPrompt(question), abortSignal: options.abortSignal };
    if (this.llm.streamTextResult) {
      const result = this.llm.streamTextResult(params);
      for await (const chunk of result.chunks) yield chunk;
      await options.onModelCall?.(await result.metadata);
      return;
    }
    for await (const chunk of this.llm.streamText(params)) yield chunk;
  }
}
