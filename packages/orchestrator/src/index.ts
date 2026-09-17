import type { LLMClientLike } from '@harness/llm';

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

function buildPrompt(question: string): string {
  return `User question: ${question}\nAnswer as the bounded FinHarness financial assistant.`;
}

/** Conversational host. Commands still own workflows and selectively invoke specialist subagents. */
export class MainFinHarnessAgent {
  constructor(private readonly llm: Pick<LLMClientLike, 'generateText' | 'streamText'>) {}

  async respond(input: string, options: { abortSignal?: AbortSignal } = {}): Promise<string> {
    const question = input.trim();
    if (IDENTITY.test(question)) {
      return IDENTITY_ANSWER;
    }
    if (CLEARLY_OFF_TOPIC.test(question)) {
      return OFF_TOPIC_ANSWER;
    }
    return this.llm.generateText({
      system: MAIN_FINHARNESS_PROMPT,
      prompt: buildPrompt(question),
      abortSignal: options.abortSignal,
    });
  }

  /**
   * Variant streaming untuk transcript percakapan (Audit doc D1/D2):
   * kembalikan AsyncIterable<string> token-per-token. Fast-path identitas/
   * off-topic menghasilkan jawaban kanonik sekali; sisanya dialirkan dari LLM.
   */
  async *stream(input: string): AsyncIterable<string> {
    const question = input.trim();
    if (IDENTITY.test(question)) {
      yield IDENTITY_ANSWER;
      return;
    }
    if (CLEARLY_OFF_TOPIC.test(question)) {
      yield OFF_TOPIC_ANSWER;
      return;
    }
    yield* this.llm.streamText({ system: MAIN_FINHARNESS_PROMPT, prompt: buildPrompt(question) });
  }
}
