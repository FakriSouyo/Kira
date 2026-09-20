import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, max, or } from 'drizzle-orm';
import type {
  ModelCallRecord,
  ResearchExecution,
  ResearchSession,
  ResearchSessionArtifacts,
  ResearchSessionStore,
  SessionModelSelection,
  ResearchTurn,
  WorkflowStepRecord,
} from '@harness/session-core';
import { transitionTurn } from '@harness/session-core';
import { ContextSnapshotIdSchema } from '@harness/context';
import { canonicalJson } from '@harness/shared';
import type { Orm } from './client';
import { contextSnapshots, executions, modelCalls, researchSessions, researchTurns, sessionModelSelections, workflowSteps } from './schema';

function toExecution(row: typeof executions.$inferSelect): ResearchExecution {
  if (row.sessionId === null || row.turnId === null || row.attempt === null) {
    throw new Error(`Execution ${row.id} is not linked to the canonical session lifecycle`);
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    attempt: row.attempt,
    ticker: row.ticker,
    command: row.command,
    status: row.status as ResearchExecution['status'],
    executionTime: row.executionTime,
    error: row.error,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    resumeGeneration: row.resumeGeneration,
  };
}

/** SQLite persistence for chat sessions, command turns, trace steps, and model calls. */
export class ResearchSessionStoreSqlite implements ResearchSessionStore {
  constructor(private readonly db: Orm) {}

  async createSession(params: Parameters<ResearchSessionStore['createSession']>[0]): Promise<ResearchSession> {
    const now = new Date().toISOString();
    const session: ResearchSession = {
      id: params.sessionId ?? `session_${randomUUID().slice(0, 8)}`,
      title: params.title,
      provider: params.provider,
      model: params.model,
      reasoningMode: params.reasoningMode,
      createdAt: now,
      updatedAt: now,
    };
    const selection: SessionModelSelection = {
      sessionId: session.id,
      version: 1,
      providerId: params.providerId ?? session.provider,
      modelId: params.modelId ?? session.model,
      source: 'initial',
      selectedAt: now,
    };
    return this.db.transaction((tx) => {
      tx.insert(researchSessions).values(session).run();
      tx.insert(sessionModelSelections).values(selection).run();
      return session;
    });
  }

  async getCurrentModelSelection(sessionId: string): Promise<SessionModelSelection | null> {
    const rows = await this.db.select().from(sessionModelSelections)
      .where(eq(sessionModelSelections.sessionId, sessionId))
      .orderBy(desc(sessionModelSelections.version)).limit(1);
    return (rows[0] as SessionModelSelection | undefined) ?? null;
  }

  async listModelSelections(sessionId: string): Promise<SessionModelSelection[]> {
    const rows = await this.db.select().from(sessionModelSelections)
      .where(eq(sessionModelSelections.sessionId, sessionId))
      .orderBy(asc(sessionModelSelections.version));
    return rows as SessionModelSelection[];
  }

  async selectModel(params: Parameters<ResearchSessionStore['selectModel']>[0]): Promise<SessionModelSelection> {
    return this.db.transaction((tx) => {
      const session = tx.select({ id: researchSessions.id }).from(researchSessions)
        .where(eq(researchSessions.id, params.sessionId)).limit(1).get();
      if (!session) throw new Error(`Session ${params.sessionId} not found`);
      if (!params.providerId.trim() || !params.modelId.trim()) throw new Error('Model selection providerId and modelId must be non-empty');
      const current = tx.select({ value: max(sessionModelSelections.version) }).from(sessionModelSelections)
        .where(eq(sessionModelSelections.sessionId, params.sessionId)).get();
      const selectedAt = params.selectedAt ?? new Date().toISOString();
      const selection: SessionModelSelection = {
        sessionId: params.sessionId,
        version: (current?.value ?? 0) + 1,
        providerId: params.providerId,
        modelId: params.modelId,
        source: params.source ?? 'user',
        selectedAt,
      };
      tx.insert(sessionModelSelections).values(selection).run();
      tx.update(researchSessions).set({ provider: selection.providerId, model: selection.modelId, updatedAt: selectedAt })
        .where(eq(researchSessions.id, params.sessionId)).run();
      return selection;
    });
  }

  async createTurn(params: Parameters<ResearchSessionStore['createTurn']>[0]): Promise<ResearchTurn> {
    const turn: ResearchTurn = {
      id: params.turnId ?? `turn_${randomUUID().slice(0, 8)}`,
      sessionId: params.sessionId,
      runId: params.runId ?? null,
      input: params.input,
      command: params.command,
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    return this.db.transaction((tx) => {
      if (params.runId) {
        const legacyRun = tx.select().from(executions).where(eq(executions.id, params.runId)).limit(1).get();
        if (!legacyRun) throw new Error(`Execution ${params.runId} not found`);
        if (legacyRun.turnId !== null || legacyRun.sessionId !== null || legacyRun.attempt !== null) {
          throw new Error(`Execution ${params.runId} already belongs to turn ${legacyRun.turnId ?? 'unknown'}`);
        }
      }
      tx.insert(researchTurns).values(turn).run();
      if (params.runId) {
        const linked = tx.update(executions).set({
          sessionId: turn.sessionId,
          turnId: turn.id,
          attempt: 1,
        }).where(and(
          eq(executions.id, params.runId),
          isNull(executions.sessionId),
          isNull(executions.turnId),
          isNull(executions.attempt),
        )).run();
        if (linked.changes !== 1) throw new Error(`Execution ${params.runId} was linked concurrently`);
      }
      tx.update(researchSessions).set({ updatedAt: turn.startedAt }).where(eq(researchSessions.id, turn.sessionId)).run();
      return turn;
    });
  }

  async settleTurn(...args: Parameters<ResearchSessionStore['settleTurn']>): Promise<ResearchTurn> {
    const [turnId, status, requestedAt] = args;
    return this.db.transaction((tx) => {
      const row = tx.select().from(researchTurns).where(eq(researchTurns.id, turnId)).limit(1).get();
      if (!row) throw new Error(`Turn ${turnId} not found`);
      const runningExecution = tx.select({ id: executions.id }).from(executions)
        .where(and(eq(executions.turnId, turnId), or(eq(executions.status, 'running'), eq(executions.status, 'interrupted')))).limit(1).get();
      if (runningExecution) {
        const execution = tx.select({ status: executions.status }).from(executions).where(eq(executions.id, runningExecution.id)).limit(1).get();
        throw new Error(`Turn ${turnId} cannot settle while execution ${runningExecution.id} is ${execution?.status ?? 'active'}`);
      }
      const settled = transitionTurn(row as ResearchTurn, status, requestedAt ?? new Date().toISOString());
      const updated = tx.update(researchTurns).set({ status: settled.status, completedAt: settled.completedAt })
        .where(and(eq(researchTurns.id, turnId), eq(researchTurns.status, 'running'))).run();
      if (updated.changes !== 1) throw new Error(`Turn ${turnId} did not settle atomically`);
      tx.update(researchSessions).set({ updatedAt: settled.completedAt ?? settled.startedAt })
        .where(eq(researchSessions.id, settled.sessionId)).run();
      return settled;
    });
  }

  async createExecution(params: Parameters<ResearchSessionStore['createExecution']>[0]): Promise<ResearchExecution> {
    return this.db.transaction((tx) => {
      const turn = tx.select().from(researchTurns).where(eq(researchTurns.id, params.turnId)).limit(1).get();
      if (!turn) throw new Error(`Turn ${params.turnId} not found`);
      if (turn.sessionId !== params.sessionId) {
        throw new Error(`Turn ${params.turnId} does not belong to session ${params.sessionId}`);
      }
      if (turn.status !== 'running') throw new Error(`Turn ${params.turnId} is already ${turn.status}`);
      const completedExecution = tx.select({ id: executions.id }).from(executions)
        .where(and(eq(executions.turnId, params.turnId), eq(executions.status, 'completed'))).limit(1).get();
      if (completedExecution) throw new Error(`Turn ${params.turnId} already completed successfully`);
      const runningExecution = tx.select({ id: executions.id }).from(executions)
        .where(and(eq(executions.turnId, params.turnId), eq(executions.status, 'running'))).limit(1).get();
      if (runningExecution) throw new Error(`Turn ${params.turnId} already has a running execution`);
      const interruptedExecution = tx.select({ id: executions.id }).from(executions)
        .where(and(eq(executions.turnId, params.turnId), eq(executions.status, 'interrupted'))).limit(1).get();
      if (interruptedExecution) throw new Error(`Turn ${params.turnId} already has an interrupted execution ${interruptedExecution.id}`);
      const attemptRow = tx.select({ value: max(executions.attempt) }).from(executions)
        .where(eq(executions.turnId, params.turnId)).get();
      const now = new Date().toISOString();
      const execution: ResearchExecution = {
        id: params.executionId ?? `run_${randomUUID().slice(0, 8)}`,
        sessionId: params.sessionId,
        turnId: params.turnId,
        attempt: (attemptRow?.value ?? 0) + 1,
        ticker: params.ticker,
        command: params.command,
        status: 'running',
        executionTime: null,
        error: null,
        createdAt: now,
        completedAt: null,
        resumeGeneration: 0,
      };
      tx.insert(executions).values(execution).run();
      tx.update(researchSessions).set({ updatedAt: now }).where(eq(researchSessions.id, params.sessionId)).run();
      return execution;
    });
  }

  async settleExecution(...args: Parameters<ResearchSessionStore['settleExecution']>): Promise<ResearchExecution> {
    const [executionId, status, result = {}] = args;
    const requestedStatus = status as string;
    if (requestedStatus === 'running' || requestedStatus === 'interrupted') {
      throw new Error(`Execution ${executionId} must use its dedicated lifecycle transition for ${requestedStatus}`);
    }
    return this.db.transaction((tx) => {
      const current = tx.select().from(executions).where(eq(executions.id, executionId)).limit(1).get();
      if (!current) throw new Error(`Execution ${executionId} not found`);
      if (current.status !== 'running') {
        throw new Error(`Execution ${executionId} is already ${current.status} — no further transitions allowed`);
      }
      const completedAt = result.completedAt ?? new Date().toISOString();
      const updated = tx.update(executions).set({
        status,
        executionTime: result.executionTimeSeconds ?? null,
        error: result.error ?? null,
        completedAt,
      }).where(and(eq(executions.id, executionId), eq(executions.status, 'running'))).run();
      if (updated.changes !== 1) throw new Error(`Execution ${executionId} did not settle atomically`);
      if (current.sessionId) {
        tx.update(researchSessions).set({ updatedAt: completedAt })
          .where(eq(researchSessions.id, current.sessionId)).run();
      }
      const settled = tx.select().from(executions).where(eq(executions.id, executionId)).limit(1).get();
      return toExecution(settled!);
    });
  }

  async interruptExecution(executionId: string, error = 'Interrupted before the execution reached a terminal state.'): Promise<ResearchExecution> {
    return this.db.transaction((tx) => {
      const current = tx.select().from(executions).where(eq(executions.id, executionId)).limit(1).get();
      if (!current) throw new Error(`Execution ${executionId} not found`);
      if (current.status !== 'running') {
        throw new Error(`Execution ${executionId} cannot transition from ${current.status} to interrupted`);
      }
      const interruptedAt = new Date().toISOString();
      const updated = tx.update(executions).set({ status: 'interrupted', error, completedAt: null })
        .where(and(eq(executions.id, executionId), eq(executions.status, 'running'))).run();
      if (updated.changes !== 1) throw new Error(`Execution ${executionId} did not interrupt atomically`);
      if (current.sessionId) {
        tx.update(researchSessions).set({ updatedAt: interruptedAt }).where(eq(researchSessions.id, current.sessionId)).run();
      }
      return toExecution(tx.select().from(executions).where(eq(executions.id, executionId)).limit(1).get()!);
    });
  }

  async acquireInterruptedExecution(executionId: string): Promise<ResearchExecution> {
    return this.db.transaction((tx) => {
      const current = tx.select().from(executions).where(eq(executions.id, executionId)).limit(1).get();
      if (!current) throw new Error(`Execution ${executionId} not found`);
      if (current.status !== 'interrupted') {
        throw new Error(`Execution ${executionId} cannot transition from ${current.status} to running`);
      }
      const resumedAt = new Date().toISOString();
      const updated = tx.update(executions).set({
        status: 'running',
        error: null,
        completedAt: null,
        executionTime: null,
        resumeGeneration: current.resumeGeneration + 1,
      }).where(and(eq(executions.id, executionId), eq(executions.status, 'interrupted'))).run();
      if (updated.changes !== 1) throw new Error(`Execution ${executionId} was acquired concurrently`);
      if (current.sessionId) {
        tx.update(researchSessions).set({ updatedAt: resumedAt }).where(eq(researchSessions.id, current.sessionId)).run();
      }
      return toExecution(tx.select().from(executions).where(eq(executions.id, executionId)).limit(1).get()!);
    });
  }

  async saveStep(params: Parameters<ResearchSessionStore['saveStep']>[0]): Promise<WorkflowStepRecord> {
    const now = new Date().toISOString();
    const step: WorkflowStepRecord = {
      id: params.stepId ?? `step_${randomUUID().slice(0, 8)}`,
      runId: params.runId,
      nodeId: params.nodeId,
      parentNodeIds: params.parentNodeIds,
      subagent: params.subagent ?? null,
      skills: params.skills,
      status: params.status,
      durationMs: params.durationMs ?? null,
      summary: params.summary ?? null,
      error: params.error ?? null,
      createdAt: now,
      completedAt: params.status === 'running' ? null : now,
    };
    const stored = { ...step, parentNodeIds: JSON.stringify(step.parentNodeIds), skills: JSON.stringify(step.skills) };
    await this.db.insert(workflowSteps).values(stored).onConflictDoUpdate({
      target: [workflowSteps.runId, workflowSteps.nodeId],
      set: {
        parentNodeIds: stored.parentNodeIds,
        subagent: stored.subagent,
        skills: stored.skills,
        status: stored.status,
        durationMs: stored.durationMs,
        summary: stored.summary,
        error: stored.error,
        completedAt: stored.completedAt,
      },
    });
    const rows = await this.db.select().from(workflowSteps)
      .where(eq(workflowSteps.runId, params.runId));
    const row = rows.find((candidate) => candidate.nodeId === params.nodeId);
    if (!row) throw new Error(`Workflow step ${params.nodeId} was not persisted`);
    return {
      ...row,
      parentNodeIds: JSON.parse(row.parentNodeIds) as string[],
      skills: JSON.parse(row.skills) as WorkflowStepRecord['skills'],
    } as WorkflowStepRecord;
  }

  async getStep(runId: string, nodeId: string): Promise<WorkflowStepRecord | null> {
    const rows = await this.db.select().from(workflowSteps)
      .where(and(eq(workflowSteps.runId, runId), eq(workflowSteps.nodeId, nodeId))).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      parentNodeIds: JSON.parse(row.parentNodeIds) as string[],
      skills: JSON.parse(row.skills) as WorkflowStepRecord['skills'],
    } as WorkflowStepRecord;
  }

  async recordModelCall(params: Parameters<ResearchSessionStore['recordModelCall']>[0]): Promise<ModelCallRecord> {
    const hasRun = params.runId !== undefined;
    const hasTurn = params.turnId !== undefined;
    if (hasRun === hasTurn) throw new Error('ModelCall must belong to exactly one execution or turn');
    const execution = hasRun
      ? await this.db.select().from(executions).where(eq(executions.id, params.runId!)).limit(1)
      : [];
    const turn = hasTurn
      ? await this.db.select().from(researchTurns).where(eq(researchTurns.id, params.turnId!)).limit(1)
      : [];
    if (hasRun && !execution[0]) throw new Error(`Execution ${params.runId} not found`);
    if (hasTurn && !turn[0]) throw new Error(`Turn ${params.turnId} not found`);
    if (hasRun && !params.stepId) throw new Error(`ModelCall ${params.runId} requires a workflow step`);
    if (hasTurn && params.stepId !== undefined) throw new Error(`Turn-owned ModelCall ${params.turnId} cannot reference a workflow step`);
    if (params.contextSnapshotId !== undefined && params.contextSnapshotId !== null) {
      ContextSnapshotIdSchema.parse(params.contextSnapshotId);
      const snapshot = await this.db.select().from(contextSnapshots)
        .where(eq(contextSnapshots.snapshotId, params.contextSnapshotId)).limit(1);
      if (!snapshot[0]) throw new Error(`ContextSnapshot ${params.contextSnapshotId} not found`);
      const ownerSessionId = execution[0]?.sessionId ?? turn[0]?.sessionId;
      const ownerTurnId = execution[0]?.turnId ?? turn[0]?.id;
      if (snapshot[0].sessionId !== ownerSessionId || snapshot[0].turnId !== ownerTurnId) {
        const owner = hasRun ? `execution ${params.runId}` : `turn ${params.turnId}`;
        throw new Error(`ContextSnapshot ${params.contextSnapshotId} session/turn does not belong to ${owner}`);
      }
    }
    const call: ModelCallRecord = {
      id: params.callId ?? `call_${randomUUID().slice(0, 8)}`,
      runId: params.runId ?? null,
      turnId: params.turnId ?? null,
      stepId: params.stepId ?? null,
      subagent: params.subagent,
      provider: params.provider,
      model: params.model,
      providerId: params.providerId ?? null,
      modelId: params.modelId ?? null,
      adapterId: params.adapterId ?? null,
      protocol: params.protocol ?? null,
      runtimeFingerprint: params.runtimeFingerprint ?? null,
      attempt: params.attempt,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cachedInputTokens: params.cachedInputTokens,
      totalTokens: params.totalTokens,
      latencyMs: params.latencyMs,
      finishReason: params.finishReason,
      contextSnapshotId: params.contextSnapshotId ?? null,
      cost: params.cost,
      currency: params.currency,
      createdAt: new Date().toISOString(),
    };

    const semantic = (value: ModelCallRecord): string => canonicalJson({
      id: value.id,
      runId: value.runId,
      turnId: value.turnId,
      stepId: value.stepId,
      subagent: value.subagent,
      provider: value.provider,
      model: value.model,
      providerId: value.providerId,
      modelId: value.modelId,
      adapterId: value.adapterId,
      protocol: value.protocol,
      runtimeFingerprint: value.runtimeFingerprint,
      attempt: value.attempt,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      cachedInputTokens: value.cachedInputTokens,
      totalTokens: value.totalTokens,
      latencyMs: value.latencyMs,
      finishReason: value.finishReason,
      contextSnapshotId: value.contextSnapshotId,
      cost: value.cost,
      currency: value.currency,
    });
    const existing = await this.db.select().from(modelCalls).where(eq(modelCalls.id, call.id)).limit(1);
    if (existing[0]) {
      const stored = existing[0] as ModelCallRecord;
      if (semantic(stored) === semantic(call)) return stored;
      throw new Error(`Model call ${call.id} immutable identity conflict`);
    }
    await this.db.insert(modelCalls).values(call);
    return call;
  }

  /** Returns audit calls for one workflow node so resume repair can be idempotent. */
  async listModelCallsForStep(runId: string, stepId: string): Promise<ModelCallRecord[]> {
    const rows = await this.db.select().from(modelCalls)
      .where(and(eq(modelCalls.runId, runId), eq(modelCalls.stepId, stepId)))
      .orderBy(asc(modelCalls.attempt), asc(modelCalls.createdAt));
    return rows as ModelCallRecord[];
  }

  async getSessionArtifacts(sessionId: string): Promise<ResearchSessionArtifacts> {
    const sessionRows = await this.db.select().from(researchSessions).where(eq(researchSessions.id, sessionId)).limit(1);
    if (!sessionRows[0]) throw new Error(`Session ${sessionId} not found`);
    const turns = await this.db.select().from(researchTurns).where(eq(researchTurns.sessionId, sessionId)).orderBy(asc(researchTurns.startedAt));
    const executionRows = await this.db.select().from(executions).where(eq(executions.sessionId, sessionId))
      .orderBy(asc(executions.createdAt), asc(executions.attempt));
    const sessionExecutions = executionRows.map(toExecution);
    const runIds = new Set(sessionExecutions.map((execution) => execution.id));
    const allSteps = await this.db.select().from(workflowSteps).orderBy(asc(workflowSteps.createdAt));
    const steps = allSteps.filter((step) => runIds.has(step.runId)).map((step) => ({
      ...step,
      parentNodeIds: JSON.parse(step.parentNodeIds) as string[],
      skills: JSON.parse(step.skills) as WorkflowStepRecord['skills'],
    })) as WorkflowStepRecord[];
    const allCalls = await this.db.select().from(modelCalls).orderBy(asc(modelCalls.createdAt));
    const turnIds = new Set(turns.map((turn) => turn.id));
    const calls = allCalls.filter((call) => (call.runId !== null && runIds.has(call.runId)) || (call.turnId !== null && turnIds.has(call.turnId))) as ModelCallRecord[];
    return {
      session: sessionRows[0] as ResearchSession,
      turns: turns as ResearchTurn[],
      executions: sessionExecutions,
      steps,
      modelCalls: calls,
    };
  }
}
