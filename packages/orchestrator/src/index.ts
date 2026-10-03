import type { LLMCallMetadata, LLMClientLike } from '@harness/llm';
import { hasTransactionDirective, ValidationError } from '@harness/shared';

export * from './conversationContext.js';

export const MAIN_KIRA_PROMPT = `Main Kira Agent — financial-only conversational host.
Human owns every transaction decision. Kira must not decide, recommend, or instruct BUY/SELL/HOLD, enter/exit, add/reduce, allocate/size/time, or place/execute orders. If asked, return the decision to the user; offer evidence/risk analysis, comparison, hypothetical, or a workflow.
Never invent current facts. For fresh claims, recommend exactly one command: /research, /judge, /compare, /challenge, /investigate, /screen, or /search.
For unrelated topics, invite finance. Reply in the user's language; never claim to be a specialist subagent.`;

const IDENTITY = /^(siapa kamu|kamu siapa|who are you|what are you|apa itu (?:kira|finharness)|kenalkan diri)[\s?!.,]*$/i;
const CLEARLY_OFF_TOPIC = /\b(resep|masak|cuaca|sepak bola|football|film|musik|game|coding|programming|puisi|cerita fiksi)\b/i;
const TRANSACTION_DECISION_REQUEST = /\b(?:should|would|could|do|shall)\s+(?:i|we)\s+(?:buy|sell|hold)\b|\b(?:buy|sell|hold)\s+or\s+(?:buy|sell|hold)\b|\b(?:is|was)\s+[A-Z][A-Z0-9.-]{1,5}\s+(?:a\s+)?(?:strong\s+)?(?:buy|sell|hold)\b|\b(?:mending|sebaiknya|haruskah)\s+(?:saya\s+)?(?:beli|jual|tahan)\b|\b(?:beli|jual)\s+atau\s+(?:beli|jual)\b|\b[A-Z][A-Z0-9.-]{1,5}\s+layak\s+(?:untuk\s+)?di(?:beli|jual|tahan)\b/i;
const INDONESIAN_TRANSACTION_REQUEST = /\b(?:mending|sebaiknya|haruskah|beli|jual|tahan|di(?:beli|jual|tahan))\b/i;

const IDENTITY_ANSWER = 'Saya Kira, mesin riset finansial berbasis evidence yang membantu menjelaskan konsep dan menjalankan workflow riset. Untuk analisis perusahaan gunakan /judge [TICKER], atau ajukan pertanyaan finansial untuk percakapan riset biasa.';
const OFF_TOPIC_ANSWER = 'Saya hanya membantu topik finansial, investasi, perusahaan, pasar, dan riset berbasis evidence. Silakan ajukan pertanyaan finansial atau tekan Ctrl+P untuk memilih workflow.';
const TRANSACTION_DECISION_ANSWER = 'Kira can analyze evidence, valuation, risks, and scenarios, but the buy/sell/hold decision belongs to you. For company-specific evidence, use /judge [TICKER].';
const TRANSACTION_DECISION_ANSWER_ID = 'Kira dapat menganalisis bukti, valuasi, risiko, dan skenario, tetapi keputusan transaksi tetap milik Anda. Untuk bukti khusus emiten, gunakan /judge [TICKER].';

export function buildMainAgentPrompt(question: string): string {
  return `User question: ${question}\nAnswer as the bounded Kira financial assistant.`;
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
  return context ? [MAIN_KIRA_PROMPT, context.rendered] : MAIN_KIRA_PROMPT;
}

/** Conversational host. Commands still own workflows and selectively invoke specialist subagents. */
export class MainKiraAgent {
  constructor(private readonly llm: Pick<LLMClientLike, 'generateTextResult' | 'streamTextResult'>) {}

  async respond(input: string, options: MainAgentCallOptions = {}): Promise<string> {
    const question = input.trim();
    if (IDENTITY.test(question)) {
      return IDENTITY_ANSWER;
    }
    if (CLEARLY_OFF_TOPIC.test(question)) {
      return OFF_TOPIC_ANSWER;
    }
    if (TRANSACTION_DECISION_REQUEST.test(question)) {
      const indonesian = INDONESIAN_TRANSACTION_REQUEST.test(question);
      const answer = indonesian ? TRANSACTION_DECISION_ANSWER_ID : TRANSACTION_DECISION_ANSWER;
      return `${indonesian ? 'Pertanyaan Anda' : 'Your question'}: ${question}\n${answer}`;
    }
    const params = {
      system: systemPrompt(options.context),
      prompt: buildMainAgentPrompt(question),
      abortSignal: options.abortSignal,
    };
    const result = await this.llm.generateTextResult(params);
    await options.onModelCall?.(result.metadata);
    if (hasTransactionDirective(result.value)) {
      throw new ValidationError('Generated response contains a transaction directive; transaction decisions belong to the human.');
    }
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
    const result = this.llm.streamTextResult(params);
    let generated = '';
    let prohibited = false;
    for await (const chunk of result.chunks) {
      if (prohibited) continue;
      const candidate = generated + chunk;
      if (hasTransactionDirective(candidate)) {
        prohibited = true;
        continue;
      }
      generated = candidate;
      yield chunk;
    }
    await options.onModelCall?.(await result.metadata);
    if (prohibited) {
      throw new ValidationError('Generated response contains a transaction directive; transaction decisions belong to the human.');
    }
  }
}
