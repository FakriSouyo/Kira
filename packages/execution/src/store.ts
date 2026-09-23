/** Siklus hidup satu eksekusi command (addendum §11/Task 5). */
export interface ExecutionRun {
  id: string;
  ticker: string;
  command: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  executionTime: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Artifact lengkap satu run (Phase 2 Task 1 — read-only session helper, tanpa migrasi). */
export interface ExecutionArtifacts {
  run: ExecutionRun;
  evidence: import('@harness/schemas').Evidence[];
  messages: import('@harness/conversation').AgentMessage[];
  claims: import('./claimStore').StoredClaim[];
  counterpoints: import('./counterpointStore').StoredCounterpoint[];
  judgment: import('./judgmentStore').StoredJudgment | null;
}

/**
 * Interface murni — tanpa tipe Drizzle (addendum §10, locked).
 * Implementasi konkret (ExecutionStoreSqlite) hidup di packages/database.
 */
export interface ExecutionStore {
  createRun(params: { ticker: string; command: string; runId?: string }): Promise<ExecutionRun>;
  completeRun(runId: string, executionTimeSeconds: number): Promise<ExecutionRun>;
  failRun(runId: string, errorMessage: string): Promise<ExecutionRun>;
  getRun(runId: string): Promise<ExecutionRun | null>;
  /** Phase 2: list runs terurut `createdAt DESC` (read-only, no migrasi). */
  listRuns(params?: { limit?: number; offset?: number; ticker?: string }): Promise<ExecutionRun[]>;
  /** Phase 2: artifact lengkap run (evidence + messages + claims + judgment) atau throw NOT_FOUND. */
  getExecutionWithArtifacts(runId: string): Promise<ExecutionArtifacts>;
}
