import type { JudgeProgressPhase } from '../workflows/judgeWorkflow';

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

/** Nama tool/fase — lihat sumber SECTORS_SOURCES di @harness/sectors-api. */
export type AgentToolName =
  | 'company_report'
  | 'quarterly_financials'
  | 'daily_transaction'
  | 'foreign_flow'
  | 'news'
  | 'filings'
  | 'sentiment';

/** Union peristiwa agent — di-serialize ke JSONL (satu baris per event). */
export type AgentEvent =
  | { type: 'session.start'; runId: string }
  | { type: 'session.complete'; runId: string; status: 'completed' | 'failed' }
  | { type: 'phase'; phase: JudgeProgressPhase; label: string }
  | { type: 'tool.start'; tool: AgentToolName; ticker?: string }
  | { type: 'tool.complete'; tool: AgentToolName; durationMs: number }
  | { type: 'evidence.found'; id: string; source: string }
  | { type: 'message.delta'; agent: string; text: string };

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