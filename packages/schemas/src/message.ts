import { z } from 'zod';
import { AGENTS, MESSAGE_TYPES } from '@harness/shared';

/** Pesan reasoning natural-language per agent (addendum §08). */
export const AgentMessageSchema = z.object({
  runId: z.string(),
  messageId: z.string(),
  agent: z.enum(AGENTS),
  messageType: z.enum(MESSAGE_TYPES),
  content: z.string(),
  evidenceIds: z.array(z.string()),
  sequenceOrder: z.number().int().min(0),
  metadata: z.record(z.unknown()).optional(),
});

export type AgentMessageInput = z.infer<typeof AgentMessageSchema>;
