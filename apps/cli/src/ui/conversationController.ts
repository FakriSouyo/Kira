import { randomUUID } from 'node:crypto';
import { projectConversation, type ConversationEvent, type ConversationSession, type ResearchSession } from '@harness/session-core';
import type { FinharnessDatabase } from '@harness/database';
import type { AgentEvent } from '../repl/events';
import type { FinharnessConfig } from '../config';

/** Owns durable conversation events; transient thinking never enters the journal. */
export class ConversationController {
  private state: ConversationSession;
  private currentRun?: string;
  private assistantId?: string;
  private activeTurn?: { id: string; executionId?: string; lastEventId?: string };
  private evidenceLabels = new Map<string, string>();
  private constructor(private readonly db: FinharnessDatabase, private readonly config: FinharnessConfig, private readonly notify: (event: AgentEvent) => void, session: ResearchSession) {
    this.state = { id: session.id, title: session.title, blocks: [], sequence: 0 };
  }
  static async create(db: FinharnessDatabase, config: FinharnessConfig, notify: (event: AgentEvent) => void): Promise<ConversationController> {
    const recent = db.journal.list().find(session => session.id.startsWith('conversation_'));
    const session = recent ?? await db.sessions.createSession({
      sessionId: `conversation_${randomUUID().slice(0, 8)}`,
      title: 'New conversation',
      provider: config.llm.agent.provider,
      model: config.llm.agent.model,
      reasoningMode: 'usual',
    });
    const controller = new ConversationController(db, config, notify, session);
    await controller.restore(session.id);
    return controller;
  }
  get snapshot(): ConversationSession { return this.state; }
  get activeRunId(): string | undefined { return this.currentRun; }
  private publish(): void { this.notify({ type: 'conversation.snapshot', session: this.state }); }
  append(payload: ConversationEvent, publish = true) {
    const versioned: ConversationEvent = { ...payload, schemaVersion: payload.schemaVersion ?? 1 };
    const correlated: ConversationEvent = this.activeTurn ? {
      ...versioned,
      turnId: versioned.turnId ?? this.activeTurn.id,
      executionId: versioned.executionId ?? this.activeTurn.executionId,
      correlationId: versioned.correlationId ?? this.activeTurn.id,
      causationId: versioned.causationId ?? this.activeTurn.lastEventId,
    } : versioned;
    const entry = this.db.journal.append(this.state.id, correlated);
    if (this.activeTurn) this.activeTurn.lastEventId = entry.id;
    this.state = projectConversation(this.state, entry);
    if (entry.sequence <= 2 && correlated.type === 'message.added' && correlated.role === 'user') {
      this.state = { ...this.state, title: correlated.content.slice(0, 70) };
    }
    if (publish) this.publish();
    return entry;
  }
  beginTurn(turnId: string): void {
    if (this.activeTurn) throw new Error(`Turn ${this.activeTurn.id} is already active in this conversation`);
    this.activeTurn = { id: turnId };
    this.append({ type: 'turn.started', id: turnId });
  }
  settleTurn(turnId: string, state: Exclude<import('@harness/session-core').RunState, 'running'>): void {
    if (this.activeTurn?.id !== turnId) throw new Error(`Turn ${turnId} is not the active conversation turn`);
    this.append({ type: 'turn.settled', id: turnId, state });
    this.activeTurn = undefined;
  }
  async restore(id: string): Promise<void> {
    const session = this.db.journal.get(id);
    if (!session) throw new Error('Conversation not found');
    const entries = this.db.journal.read(id);
    this.state = entries.reduce(projectConversation, { id, title: session.title, blocks: [], sequence: 0 } as ConversationSession);
    this.evidenceLabels = this.db.journal.evidenceLabels(id);
    this.currentRun = undefined; this.assistantId = undefined; this.activeTurn = undefined;

    // Canonical lifecycle wins over an incomplete projection after process loss.
    const artifacts = await this.db.sessions.getSessionArtifacts(id);
    const executions = new Map(artifacts.executions.map(execution => [execution.id, execution]));
    const origins = new Map(entries
      .filter(entry => entry.payload.type === 'message.added' || entry.payload.type === 'run.started')
      .map(entry => [entry.payload.id, entry]));
    const lastByTurn = new Map<string, (typeof entries)[number]>();
    for (const entry of entries) if (entry.payload.turnId) lastByTurn.set(entry.payload.turnId, entry);
    for (const execution of executions.values()) {
      if (execution.status === 'running') {
        executions.set(execution.id, await this.db.sessions.interruptExecution(execution.id));
      }
    }
    const settledTurns: Array<{ id: string; state: 'completed' | 'failed' | 'cancelled' }> = [];
    for (const turn of artifacts.turns) {
      if (turn.status !== 'running') continue;
      const attempts = [...executions.values()].filter(execution => execution.turnId === turn.id);
      const status = attempts.some(execution => execution.status === 'completed')
        ? 'completed' as const
        : attempts.some(execution => execution.status === 'failed')
          ? 'failed' as const
          : attempts.some(execution => execution.status === 'interrupted')
            ? null
            : 'stopped' as const;
      if (status === null) continue;
      await this.db.sessions.settleTurn(turn.id, status);
      settledTurns.push({ id: turn.id, state: status === 'stopped' ? 'cancelled' : status });
    }

    // A previous process cannot still stream into this conversation. Retain partial content,
    // but close projected blocks using the canonical terminal state when one exists.
    for (const block of this.state.blocks) {
      if (block.state !== 'running') continue;
      if (block.kind === 'run') {
        const execution = executions.get(block.id);
        const origin = origins.get(block.id);
        const turnId = execution?.turnId ?? origin?.payload.turnId;
        // An interrupted canonical execution is intentionally left visible and
        // resumable; no terminal projection or turn settlement is synthesized.
        if (execution?.status === 'interrupted') continue;
        const state = execution?.status === 'completed' ? 'completed'
          : execution?.status === 'failed' ? 'failed'
            : 'cancelled';
        const settled = this.append({
          type: 'run.settled', id: block.id, state,
          ...(turnId ? {
            turnId, executionId: execution?.id ?? origin?.payload.executionId,
            correlationId: origin?.payload.correlationId ?? turnId,
            causationId: lastByTurn.get(turnId)?.id,
          } : {}),
          ...(state === 'cancelled' ? { error: 'Interrupted. Research collected so far remains available.' } : {}),
        }, false);
        if (turnId) lastByTurn.set(turnId, settled);
      } else {
        const origin = origins.get(block.id);
        const turnId = origin?.payload.turnId;
        const settled = this.append({
          type: 'message.settled', id: block.id, state: 'cancelled',
          ...(turnId ? {
            turnId, executionId: origin?.payload.executionId,
            correlationId: origin?.payload.correlationId ?? turnId,
            causationId: lastByTurn.get(turnId)?.id,
          } : {}),
        }, false);
        if (turnId) lastByTurn.set(turnId, settled);
      }
    }
    for (const turn of settledTurns) {
      const settled = this.append({
        type: 'turn.settled', id: turn.id, state: turn.state, turnId: turn.id,
        correlationId: turn.id, causationId: lastByTurn.get(turn.id)?.id,
      }, false);
      lastByTurn.set(turn.id, settled);
    }
  }
  async open(id: string): Promise<void> { await this.restore(id); this.publish(); }
  async newConversation(): Promise<void> {
    const session = await this.db.sessions.createSession({
      sessionId: `conversation_${randomUUID().slice(0, 8)}`,
      title: 'New conversation',
      provider: this.config.llm.agent.provider,
      model: this.config.llm.agent.model,
      reasoningMode: 'usual',
    });
    await this.restore(session.id); this.publish();
  }
  safeInput(content: string): string {
    return /^\s*\/auth-set\b/i.test(content) ? '/auth-set [credentials hidden]' : content;
  }
  user(content: string): void {
    const safe = this.safeInput(content);
    this.append({ type: 'message.added', id: `message${this.state.sequence + 1}`, role: 'user', content: safe, state: 'completed' });
  }
  output(content: string): void {
    if (!content.trim()) return;
    this.append({ type: 'message.added', id: `message${this.state.sequence + 1}`, role: 'assistant', content: this.publicText(content), state: 'completed' });
  }
  publicText(text: string): string {
    let safe = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    for (const [internal, label] of this.evidenceLabels) safe = safe.replaceAll(internal, label);
    return safe.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[reference]');
  }
  accept(event: AgentEvent): void {
    switch (event.type) {
      case 'conversation.start':
        this.assistantId = undefined;
        this.notify({ type: 'conversation.thinking', active: true });
        break;
      case 'conversation.delta': {
        if (!this.assistantId && !event.content.trim()) return;
        this.notify({ type: 'conversation.thinking', active: false });
        if (!this.assistantId) {
          this.assistantId = `message${this.state.sequence + 1}`;
          this.append({ type: 'message.added', id: this.assistantId, role: 'assistant', content: this.publicText(event.content), state: 'running' });
        } else this.append({ type: 'message.delta', id: this.assistantId, content: this.publicText(event.content) });
        break;
      }
      case 'conversation.complete':
      case 'conversation.failed':
        this.notify({ type: 'conversation.thinking', active: false });
        if (this.assistantId) this.append({ type: 'message.settled', id: this.assistantId, state: event.type === 'conversation.complete' ? 'completed' : event.error?.code === 'ABORTED' ? 'cancelled' : 'failed' });
        this.assistantId = undefined;
        break;
      case 'session.start':
        this.currentRun = event.executionId ?? event.runId;
        if (this.activeTurn) this.activeTurn.executionId = this.currentRun;
        this.append({ type: 'run.started', id: this.currentRun, subject: event.ticker ?? '', command: 'judge' });
        break;
      case 'session.complete':
        if (this.currentRun) this.append({ type: 'run.settled', id: this.currentRun, state: event.status === 'completed' ? 'completed' : event.status === 'stopped' || event.error?.code === 'ABORTED' ? 'cancelled' : 'failed', error: event.error ? this.publicText(event.error.message) : undefined });
        break;
    }
  }
}
