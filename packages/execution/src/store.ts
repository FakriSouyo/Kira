/** Siklus hidup satu eksekusi command (addendum §11/Task 5). */
export interface ExecutionRun {
  id: string;
  ticker: string;
  command: string;
  status: 'running' | 'completed' | 'failed';
  executionTime: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
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
}
