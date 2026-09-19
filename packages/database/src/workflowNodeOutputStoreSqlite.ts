import { asc, eq } from 'drizzle-orm';
import { canonicalJson } from '@harness/shared';
import {
  createWorkflowNodeOutput,
  WorkflowNodeOutputConflictError,
  type JsonValue,
  type WorkflowNodeOutput,
  type WorkflowNodeOutputStore,
} from '@harness/session-core';
import type { Orm } from './client';
import { executionProfiles, executions, workflowNodeOutputs } from './schema';

function toOutput(row: typeof workflowNodeOutputs.$inferSelect): WorkflowNodeOutput {
  const output = createWorkflowNodeOutput({
    outputId: row.outputId,
    executionId: row.executionId,
    workflowId: row.workflowId,
    workflowVersion: row.workflowVersion,
    nodeId: row.nodeId,
    status: row.status as 'completed' | 'skipped',
    outputKind: row.outputKind,
    dependencyFingerprint: row.dependencyFingerprint,
    payload: row.payloadJson === null ? null : JSON.parse(row.payloadJson) as JsonValue,
    completionGeneration: row.completionGeneration,
    createdAt: row.createdAt,
  });
  if (row.schemaVersion !== output.schemaVersion || row.outputFingerprint !== output.outputFingerprint) {
    throw new Error(`Workflow node output ${row.outputId} failed integrity validation`);
  }
  return output;
}

function sameSemanticOutput(left: WorkflowNodeOutput, right: WorkflowNodeOutput): boolean {
  return left.outputFingerprint === right.outputFingerprint
    && left.executionId === right.executionId
    && left.workflowId === right.workflowId
    && left.workflowVersion === right.workflowVersion
    && left.nodeId === right.nodeId
    && left.status === right.status
    && left.outputKind === right.outputKind
    && left.dependencyFingerprint === right.dependencyFingerprint
    && left.completionGeneration === right.completionGeneration;
}

/** Immutable, fenced persistence for future workflow restore seeds. */
export class WorkflowNodeOutputStoreSqlite implements WorkflowNodeOutputStore {
  constructor(private readonly db: Orm) {}

  async save<TPayload extends JsonValue>(output: WorkflowNodeOutput<TPayload>): Promise<WorkflowNodeOutput<TPayload>> {
    const canonical = createWorkflowNodeOutput({
      outputId: output.outputId,
      executionId: output.executionId,
      workflowId: output.workflowId,
      workflowVersion: output.workflowVersion,
      nodeId: output.nodeId,
      status: output.status,
      outputKind: output.outputKind,
      dependencyFingerprint: output.dependencyFingerprint,
      payload: output.payload,
      completionGeneration: output.completionGeneration,
      createdAt: output.createdAt,
    });
    if (output.schemaVersion !== canonical.schemaVersion || output.outputFingerprint !== canonical.outputFingerprint) {
      throw new WorkflowNodeOutputConflictError(`Workflow node output ${output.executionId}/${output.nodeId} has an invalid identity`);
    }

    return this.db.transaction((tx) => {
      const execution = tx.select().from(executions).where(eq(executions.id, output.executionId)).limit(1).get();
      if (!execution || execution.sessionId === null || execution.turnId === null || execution.attempt === null) {
        throw new Error(`Execution ${output.executionId} is not linked to the canonical session lifecycle`);
      }
      const profile = tx.select().from(executionProfiles).where(eq(executionProfiles.executionId, output.executionId)).limit(1).get();
      if (!profile) throw new Error(`Execution ${output.executionId} has no execution profile`);
      if (profile.workflowId !== output.workflowId || profile.workflowVersion !== output.workflowVersion) {
        throw new WorkflowNodeOutputConflictError(`Workflow node output ${output.executionId}/${output.nodeId} does not match its execution profile`);
      }
      if (execution.resumeGeneration !== output.completionGeneration) {
        throw new WorkflowNodeOutputConflictError(`Workflow node output ${output.executionId}/${output.nodeId} belongs to stale resume generation ${output.completionGeneration}`);
      }

      const existing = tx.select().from(workflowNodeOutputs).where(eq(workflowNodeOutputs.executionId, output.executionId))
        .all().find((candidate) => candidate.nodeId === output.nodeId);
      const byId = tx.select().from(workflowNodeOutputs).where(eq(workflowNodeOutputs.outputId, output.outputId)).limit(1).get();
      if (existing || byId) {
        const stored = toOutput(existing ?? byId!);
        if (sameSemanticOutput(stored, output)) return stored as WorkflowNodeOutput<TPayload>;
        throw new WorkflowNodeOutputConflictError(`Workflow node output ${output.executionId}/${output.nodeId} is immutable and already has a different value`);
      }

      tx.insert(workflowNodeOutputs).values({
        outputId: output.outputId,
        schemaVersion: output.schemaVersion,
        executionId: output.executionId,
        workflowId: output.workflowId,
        workflowVersion: output.workflowVersion,
        nodeId: output.nodeId,
        status: output.status,
        outputKind: output.outputKind,
        dependencyFingerprint: output.dependencyFingerprint,
        outputFingerprint: output.outputFingerprint,
        payloadJson: output.payload === null ? null : canonicalJson(output.payload),
        completionGeneration: output.completionGeneration,
        createdAt: output.createdAt,
      }).run();
      return output;
    });
  }

  async getNodeOutput<TPayload extends JsonValue = JsonValue>(executionId: string, nodeId: string): Promise<WorkflowNodeOutput<TPayload> | null> {
    const rows = await this.db.select().from(workflowNodeOutputs).where(eq(workflowNodeOutputs.executionId, executionId));
    const row = rows.find((candidate) => candidate.nodeId === nodeId);
    return row ? toOutput(row) as WorkflowNodeOutput<TPayload> : null;
  }

  async listNodeOutputsForExecution<TPayload extends JsonValue = JsonValue>(executionId: string): Promise<WorkflowNodeOutput<TPayload>[]> {
    const rows = await this.db.select().from(workflowNodeOutputs)
      .where(eq(workflowNodeOutputs.executionId, executionId)).orderBy(asc(workflowNodeOutputs.createdAt), asc(workflowNodeOutputs.nodeId));
    return rows.map((row) => toOutput(row) as WorkflowNodeOutput<TPayload>);
  }
}
