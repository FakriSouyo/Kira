import type { JudgeProgressPhase } from '../workflows/judgeWorkflow';
import type { ConversationSession } from '@harness/session-core';

/**
 * Agent-Events JSONL (Phase 2 Task 2) — lapisan emit peristiwa run /judge
 * berupa satu objek JSON per baris, sehingga TUI Go / Web / CI dapat menempel
 * tanpa mengubah engine TypeScript (keputusan: engine tetap TS, parsing
 * peristiwa terpusat di sini).
 *
 * Urutan garis besar untuk /judge:
 *   session.start → (phase researcher) → tool.start/complete per sumber ×
 *   evidence.found per save → (phase bull/bear/judge) → session.complete.
 */

/** Nama tool/fase — source provenance tetap dicatat oleh provider adapter. */
export type AgentToolName =
  | 'company_report'
  | 'quarterly_financials'
  | 'daily_transaction'
  | 'foreign_flow'
  | 'news'
  | 'filings'
  | 'sentiment';

/** Public roles rendered by terminal and web consumers. */
export type AgentName = 'researcher' | 'bull' | 'bear' | 'judge';

export interface AgentEventError {
  code: string;
  message: string;
  suggestion?: string;
}

export type UiWorkflowStepStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'cancelled';
export interface UiWorkflowNode {
  id: string;
  label: string;
  parentIds: string[];
  owner?: string;
}

/** Mode chat tempat sebuah pesan conversation diproduksi (Audit doc A3). */
export type ConversationMode = 'conversation' | 'command' | 'research';

/** Pesan linear pada transcript chat biasa (meski sudah ada, tidak menyerupai panel activity). */
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  mode: ConversationMode;
  content: string;
  status: 'streaming' | 'completed' | 'failed';
  createdAt: number;
  command?: string;
  runId?: string;
  error?: AgentEventError;
}

/* ── Model kontrak render /judge (Fase 1 plan v2) ─────────────────────────
 * Di-definisikan di lapisan events (bukan ui/state) supaya arah dependensi
 * tetap events ← state (state meng-import events, bukan sebaliknya).
 * Report membawa verdict INLINE (bukan ref ke UiVerdict) agar self-contained.
 */
export type UiJudgeRowKind = 'claim' | 'counter' | 'rebuttal';
export interface UiJudgeRow {
  kind: UiJudgeRowKind;
  /** Label posisi referee, mis. "BULL #1", "BEAR → #2", "REBUTTAL". */
  ref: string;
  text: string;
  strength?: 'high' | 'moderate' | 'low';
  evidenceIds: string[];
}
export interface UiJudgeRoundAgent {
  role: 'bull' | 'bear' | 'rebuttal';
  reasoning: string;
  rows: UiJudgeRow[];
}
export interface UiJudgeRound {
  bull: UiJudgeRoundAgent;
  bear?: UiJudgeRoundAgent;
  rebuttal?: UiJudgeRoundAgent;
}
export interface UiJudgeBreakdown {
  financialHealth: number;
  growth: number;
  valuation: number;
  marketMomentum: number | null;
  risk: number | null;
}
export interface UiJudgeVerdict {
  stance: string;
  score: number;
  confidence: string;
  evidenceCount: number;
  rounds: number;
  summary?: string;
  breakdown?: UiJudgeBreakdown;
}
export interface UiJudgeCoins {
  challenging: number;
  referenced: number;
  conflicts: number;
  unresolved: number;
}
export interface UiJudgeReport {
  ticker: string;
  verdict: UiJudgeVerdict;
  rounds: UiJudgeRound[];
  evidence: Array<{ id: string; source: string }>;
  coin: UiJudgeCoins;
  /** Kunci ekspansi per sentinel (K3): key `role:n` / `arg:index` → expanded. */
  expand: Record<string, boolean>;
}

/** Union peristiwa agent — di-serialize ke JSONL (satu baris per event). */
export type AgentEvent =
  | { type: 'conversation.snapshot'; session: ConversationSession }
  | { type: 'conversation.thinking'; active: boolean }
  | { type: 'session.start'; runId: string; sessionId?: string; turnId?: string; executionId?: string; ticker?: string }
  | { type: 'session.complete'; runId: string; sessionId?: string; turnId?: string; executionId?: string; status: 'completed' | 'failed' | 'stopped'; error?: AgentEventError }
  | { type: 'workflow.plan'; workflowId: string; nodes: UiWorkflowNode[] }
  | { type: 'workflow.step'; workflowId: string; nodeId: string; label: string; status: UiWorkflowStepStatus; parentIds?: string[]; owner?: string; durationMs?: number; error?: string }
  | { type: 'usage'; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; totalTokens: number | null; cost: number | null; currency: string | null; durationMs: number | null }
  | { type: 'phase'; phase: JudgeProgressPhase; label: string }
  | { type: 'agent.start'; agent: AgentName }
  | { type: 'agent.text'; agent: AgentName; text: string }
  | { type: 'agent.complete'; agent: AgentName }
  | { type: 'tool.start'; tool: AgentToolName; ticker?: string; agent?: AgentName }
  | { type: 'tool.complete'; tool: AgentToolName; durationMs: number; agent?: AgentName; error?: string }
  | { type: 'evidence.found'; id: string; source: string }
  | { type: 'verdict'; stance: string; score: number; confidence: string; evidenceCount: number; rounds: number; summary?: string; breakdown?: { financialHealth: number; growth: number; valuation: number; marketMomentum: number | null; risk: number | null } }
  | { type: 'judge.report'; report: UiJudgeReport }
  | { type: 'judge.toggle'; id: string }
  | { type: 'command.output'; text: string }
  | { type: 'message.delta'; agent: string; text: string }
  | { type: 'conversation.start'; id: string; mode?: ConversationMode; command?: string; runId?: string }
  | { type: 'conversation.user'; id: string; content: string; createdAt: number }
  | { type: 'conversation.delta'; id: string; content: string }
  | { type: 'conversation.complete'; id: string }
  | { type: 'conversation.failed'; id: string; error?: AgentEventError };

/** Satu baris JSON (tanpa trailing newline) untuk konsumen JSONL/stdio. */
export function serializeAgentEvent(event: AgentEvent): string {
  return JSON.stringify(event);
}

/**
 * Buat sink emit peristiwa. Bila `output` diberikan → tulis satu baris JSONL
 * per event; bila tidak (default) → no-op. 'label' fase diplomatis ke nama
 * fase utk keterbacaan.
 */
export function createEventSink(output?: NodeJS.WritableStream): (event: AgentEvent) => void {
  if (!output) return () => {};
  return (event) => {
    output.write(serializeAgentEvent(event) + '\n');
  };
}

/** Label fase utk event `phase` (bisa ditegakkan konsisten dgn PHASE_HEADERS renderer). */
export function phaseLabel(phase: JudgeProgressPhase): string {
  const labels: Record<JudgeProgressPhase, string> = {
    researcher: 'Researcher',
    bull: 'Bull Agent',
    bear: 'Bear Agent',
    judge: 'Judge',
  };
  return labels[phase];
}
