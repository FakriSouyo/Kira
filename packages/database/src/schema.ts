import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Mirror Drizzle dari DDL di migrations/0001_initial.sql (source of truth).
 * Konvensi penamaan (addendum §16): snake_case di DB ↔ camelCase di TS,
 * pemetaan eksplisit di sini — satu-satunya tempat yang tahu dua konvensi ini.
 */

export const executions = sqliteTable('executions', {
  id: text('id').primaryKey(),
  ticker: text('ticker').notNull(),
  command: text('command').notNull(),
  status: text('status').notNull(),
  executionTime: real('execution_time'),
  error: text('error'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  completedAt: text('completed_at'),
});

export const evidence = sqliteTable('evidence', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  ticker: text('ticker').notNull(),
  source: text('source').notNull(),
  sourceType: text('source_type').notNull(),
  contentHash: text('content_hash').notNull(),
  retrievedAt: text('retrieved_at').notNull(),
  validAt: text('valid_at'),
  data: text('data').notNull(),
  provenance: text('provenance'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const agentMessages = sqliteTable('agent_messages', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  messageId: text('message_id').notNull(),
  agent: text('agent').notNull(),
  messageType: text('message_type').notNull(),
  content: text('content').notNull(),
  evidenceIds: text('evidence_ids').notNull(),
  metadata: text('metadata'),
  sequenceOrder: integer('sequence_order').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const claims = sqliteTable('claims', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  messageId: text('message_id'),
  claimId: text('claim_id').notNull(),
  statement: text('statement').notNull(),
  confidence: text('confidence').notNull(),
  reasoning: text('reasoning'),
  evidenceIds: text('evidence_ids').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const judgments = sqliteTable('judgments', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  ticker: text('ticker').notNull(),
  score: integer('score').notNull(),
  stance: text('stance'),
  confidence: text('confidence'),
  breakdown: text('breakdown').notNull(),
  summary: text('summary'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const financialsNormalized = sqliteTable('financials_normalized', {
  id: text('id').primaryKey(),
  ticker: text('ticker').notNull(),
  year: integer('year').notNull(),
  revenue: real('revenue'),
  earnings: real('earnings'),
  roe: real('roe'),
  netMargin: real('net_margin'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const dailyNormalized = sqliteTable('daily_normalized', {
  id: text('id').primaryKey(),
  ticker: text('ticker').notNull(),
  date: text('date').notNull(),
  closePrice: real('close_price'),
  volume: integer('volume'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});
