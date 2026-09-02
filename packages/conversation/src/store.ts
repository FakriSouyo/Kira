import type { AgentName, MessageType } from '@harness/shared';

/** Satu pesan reasoning dalam Conversation Store (addendum §08). */
export interface AgentMessage {
  id: string;
  runId: string;
  messageId: string;
  agent: AgentName;
  messageType: MessageType;
  content: string;
  evidenceIds: string[];
  metadata: Record<string, unknown> | null;
  sequenceOrder: number;
  createdAt: string;
}

/**
 * Interface murni — tanpa tipe Drizzle (addendum §10, locked).
 * Implementasi konkret (ConversationStoreSqlite) hidup di packages/database.
 */
export interface ConversationStore {
  addMessage(params: {
    runId: string;
    messageId: string;
    agent: AgentName;
    messageType: MessageType;
    content: string;
    evidenceIds: string[];
    sequenceOrder: number;
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  /** Conversation penuh, terurut sequence_order. */
  getByRun(runId: string): Promise<AgentMessage[]>;

  getByAgent(runId: string, agent: AgentName): Promise<AgentMessage[]>;
}
