import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { canonicalJson } from '@harness/shared';
import type { Orm } from './client';
import { agentMessages } from './schema';
import type { AgentMessage, ConversationStore } from '@harness/conversation';
import type { AgentName, MessageType } from '@harness/shared';

interface MessageRow {
  id: string;
  runId: string;
  messageId: string;
  agent: string;
  messageType: string;
  content: string;
  evidenceIds: string;
  metadata: string | null;
  sequenceOrder: number;
  createdAt: string;
}

function toMessage(row: MessageRow): AgentMessage {
  return {
    id: row.id,
    runId: row.runId,
    messageId: row.messageId,
    agent: row.agent as AgentName,
    messageType: row.messageType as MessageType,
    content: row.content,
    evidenceIds: JSON.parse(row.evidenceIds) as string[],
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    sequenceOrder: row.sequenceOrder,
    createdAt: row.createdAt,
  };
}

/** Implementasi SQLite dari ConversationStore (addendum §08). */
export class ConversationStoreSqlite implements ConversationStore {
  constructor(private readonly db: Orm) {}

  async addMessage(params: {
    runId: string;
    messageId: string;
    agent: AgentName;
    messageType: MessageType;
    content: string;
    evidenceIds: string[];
    sequenceOrder: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const input = {
      id: randomUUID(),
      runId: params.runId,
      messageId: params.messageId,
      agent: params.agent,
      messageType: params.messageType,
      content: params.content,
      evidenceIds: JSON.stringify(params.evidenceIds),
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
      sequenceOrder: params.sequenceOrder,
    };
    await this.db.insert(agentMessages).values(input).onConflictDoNothing({ target: [agentMessages.runId, agentMessages.messageId] });
    const stored = await this.db.select().from(agentMessages).where(and(
      eq(agentMessages.runId, params.runId), eq(agentMessages.messageId, params.messageId),
    )).limit(1);
    if (!stored[0]) throw new Error(`Message ${params.messageId} was not persisted`);
    const semantic = (message: MessageRow): string => canonicalJson({
      runId: message.runId,
      messageId: message.messageId,
      agent: message.agent,
      messageType: message.messageType,
      content: message.content,
      evidenceIds: JSON.parse(message.evidenceIds),
      metadata: message.metadata ? JSON.parse(message.metadata) : null,
      sequenceOrder: message.sequenceOrder,
    });
    if (semantic(stored[0] as MessageRow) !== semantic({
      ...input,
      evidenceIds: input.evidenceIds,
    } as unknown as MessageRow)) {
      throw new Error(`Message ${params.runId}/${params.messageId} immutable identity conflict`);
    }
  }

  async getByRun(runId: string): Promise<AgentMessage[]> {
    const rows = await this.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.runId, runId))
      .orderBy(asc(agentMessages.sequenceOrder));
    return rows.map((r) => toMessage(r as MessageRow));
  }

  async getByAgent(runId: string, agent: AgentName): Promise<AgentMessage[]> {
    const rows = await this.db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.runId, runId), eq(agentMessages.agent, agent)))
      .orderBy(asc(agentMessages.sequenceOrder));
    return rows.map((r) => toMessage(r as MessageRow));
  }
}
