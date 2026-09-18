import { and, asc, desc, eq, max } from 'drizzle-orm';
import type { ConversationEntry, ConversationEvent, ResearchSession } from '@harness/session-core';
import type { Orm } from './client';
import { conversationEvents, conversationEvidence, researchSessions } from './schema';

/** Synchronous local journal: sequence allocation and append share one SQLite transaction. */
export class ConversationJournalSqlite {
  constructor(private readonly db: Orm) {}

  list(): ResearchSession[] {
    return this.db.select().from(researchSessions).orderBy(desc(researchSessions.updatedAt)).all() as ResearchSession[];
  }

  get(id: string): ResearchSession | undefined {
    return this.db.select().from(researchSessions).where(eq(researchSessions.id, id)).get() as ResearchSession | undefined;
  }

  read(sessionId: string): ConversationEntry[] {
    return this.db.select().from(conversationEvents).where(eq(conversationEvents.sessionId, sessionId)).orderBy(asc(conversationEvents.sequence)).all()
      .map(row => ({ id: `event${row.sequence}`, sessionId, sequence: row.sequence, createdAt: row.createdAt, payload: JSON.parse(row.payload) as ConversationEvent }));
  }

  append(sessionId: string, payload: ConversationEvent): ConversationEntry {
    return this.db.transaction(tx => {
      const sequence = (tx.select({ value: max(conversationEvents.sequence) }).from(conversationEvents).where(eq(conversationEvents.sessionId, sessionId)).get()?.value ?? 0) + 1;
      const createdAt = new Date().toISOString();
      tx.insert(conversationEvents).values({ sessionId, sequence, createdAt, payload: JSON.stringify(payload) }).run();
      const firstVisibleInput = sequence <= 2 && payload.type === 'message.added' && payload.role === 'user';
      tx.update(researchSessions).set({ updatedAt: createdAt, ...(firstVisibleInput ? { title: payload.content.slice(0, 70) } : {}) }).where(eq(researchSessions.id, sessionId)).run();
      return { id: `event${sequence}`, sessionId, sequence, createdAt, payload };
    });
  }

  /** Highest sequence for the session (0 when empty) — the journal prefix observed by a writer. */
  lastSequence(sessionId: string): number {
    return this.db.select({ value: max(conversationEvents.sequence) }).from(conversationEvents)
      .where(eq(conversationEvents.sessionId, sessionId)).get()?.value ?? 0;
  }

  evidenceLabels(sessionId: string): Map<string, string> {
    return new Map(this.db.select().from(conversationEvidence).where(eq(conversationEvidence.sessionId, sessionId)).all().map(row => [row.internalId, `E${row.displayNumber}`]));
  }

  labelEvidence(sessionId: string, internalId: string): string {
    return this.db.transaction(tx => {
      const known = tx.select().from(conversationEvidence).where(and(eq(conversationEvidence.sessionId, sessionId), eq(conversationEvidence.internalId, internalId))).get();
      if (known) return `E${known.displayNumber}`;
      const displayNumber = (tx.select({ value: max(conversationEvidence.displayNumber) }).from(conversationEvidence).where(eq(conversationEvidence.sessionId, sessionId)).get()?.value ?? 0) + 1;
      tx.insert(conversationEvidence).values({ sessionId, internalId, displayNumber }).run();
      return `E${displayNumber}`;
    });
  }
}
