import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text, primaryKey, unique, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Mirror Drizzle dari DDL di migrations/0001_initial.sql (source of truth).
 * Konvensi penamaan (addendum §16): snake_case di DB ↔ camelCase di TS,
 * pemetaan eksplisit di sini — satu-satunya tempat yang tahu dua konvensi ini.
 */

export const researchSessions = sqliteTable('research_sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  reasoningMode: text('reasoning_mode').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Q2: append-only, per-session durable model intent. */
export const sessionModelSelections = sqliteTable('session_model_selections', {
  sessionId: text('session_id').notNull().references(() => researchSessions.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  providerId: text('provider_id').notNull(),
  modelId: text('model_id').notNull(),
  source: text('source').notNull(),
  selectedAt: text('selected_at').notNull(),
}, table => [primaryKey({ columns: [table.sessionId, table.version] })]);

export const researchTurns = sqliteTable('research_turns', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => researchSessions.id, { onDelete: 'cascade' }),
  /** Transitional read compatibility only; new execution ownership is executions.turn_id. */
  runId: text('run_id'),
  input: text('input').notNull(),
  command: text('command').notNull(),
  status: text('status').notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
});

export const executions = sqliteTable('executions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').references(() => researchSessions.id, { onDelete: 'cascade' }),
  turnId: text('turn_id').references(() => researchTurns.id, { onDelete: 'cascade' }),
  attempt: integer('attempt'),
  ticker: text('ticker').notNull(),
  command: text('command').notNull(),
  status: text('status').notNull(),
  executionTime: real('execution_time'),
  error: text('error'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  completedAt: text('completed_at'),
  resumeGeneration: integer('resume_generation').notNull().default(0),
}, (table) => [
  uniqueIndex('executions_turn_attempt_uniq').on(table.turnId, table.attempt).where(sql`${table.turnId} IS NOT NULL`),
]);

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

export const runEvidence = sqliteTable('run_evidence', {
  runId: text('run_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
  evidenceId: text('evidence_id').notNull().references(() => evidence.id, { onDelete: 'cascade' }),
}, (table) => [primaryKey({ columns: [table.runId, table.evidenceId] })]);

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

/** PR F: immutable, typed output envelope linked to canonical lifecycle rows. */
export const artifacts = sqliteTable('artifacts', {
  artifactId: text('artifact_id').primaryKey(),
  kind: text('kind').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  sessionId: text('session_id').notNull().references(() => researchSessions.id, { onDelete: 'cascade' }),
  turnId: text('turn_id').notNull().references(() => researchTurns.id, { onDelete: 'cascade' }),
  executionId: text('execution_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
  ticker: text('ticker').notNull(),
  payloadJson: text('payload_json').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [unique('artifacts_execution_kind_uniq').on(table.executionId, table.kind)]);

/** PR N: immutable, execution-scoped verified financial inputs. */
export const financialSnapshots = sqliteTable('financial_snapshots', {
  snapshotId: text('snapshot_id').primaryKey(),
  schemaVersion: integer('schema_version').notNull(),
  sessionId: text('session_id').notNull().references(() => researchSessions.id, { onDelete: 'cascade' }),
  turnId: text('turn_id').notNull().references(() => researchTurns.id, { onDelete: 'cascade' }),
  executionId: text('execution_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
  ticker: text('ticker').notNull(),
  payloadJson: text('payload_json').notNull(),
  fingerprint: text('fingerprint').notNull(),
  createdAt: text('created_at').notNull(),
  finalizedAt: text('finalized_at').notNull(),
}, (table) => [unique('financial_snapshots_execution_uniq').on(table.executionId)]);

/** PR O: immutable semantic configuration captured before provider/model work. */
export const executionProfiles = sqliteTable('execution_profiles', {
  executionId: text('execution_id').primaryKey().references(() => executions.id, { onDelete: 'cascade' }),
  schemaVersion: integer('schema_version').notNull(),
  workflowId: text('workflow_id').notNull(),
  workflowVersion: integer('workflow_version').notNull(),
  graphFingerprint: text('graph_fingerprint').notNull(),
  command: text('command').notNull(),
  ticker: text('ticker').notNull(),
  payloadJson: text('payload_json').notNull(),
  fingerprint: text('fingerprint').notNull(),
  createdAt: text('created_at').notNull(),
});

/** PR O: immutable, typed, execution-scoped node outputs for future restore planning. */
export const workflowNodeOutputs = sqliteTable('workflow_node_outputs', {
  outputId: text('output_id').primaryKey(),
  schemaVersion: integer('schema_version').notNull(),
  executionId: text('execution_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
  workflowId: text('workflow_id').notNull(),
  workflowVersion: integer('workflow_version').notNull(),
  nodeId: text('node_id').notNull(),
  status: text('status').notNull(),
  outputKind: text('output_kind').notNull(),
  dependencyFingerprint: text('dependency_fingerprint').notNull(),
  outputFingerprint: text('output_fingerprint').notNull(),
  payloadJson: text('payload_json'),
  completionGeneration: integer('completion_generation').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  unique('workflow_node_outputs_execution_node_uniq').on(table.executionId, table.nodeId),
]);

export const financialsNormalized = sqliteTable('financials_normalized', {
  id: text('id').primaryKey(),
  ticker: text('ticker').notNull(),
  year: integer('year').notNull(),
  revenue: real('revenue'),
  earnings: real('earnings'),
  roe: real('roe'),
  netMargin: real('net_margin'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [unique('financials_ticker_year_uniq').on(t.ticker, t.year)]);

export const dailyNormalized = sqliteTable('daily_normalized', {
  id: text('id').primaryKey(),
  ticker: text('ticker').notNull(),
  date: text('date').notNull(),
  closePrice: real('close_price'),
  volume: integer('volume'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [unique('daily_ticker_date_uniq').on(t.ticker, t.date)]);

export const workflowSteps = sqliteTable('workflow_steps', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  parentNodeIds: text('parent_node_ids').notNull(),
  subagent: text('subagent'),
  skills: text('skills').notNull(),
  status: text('status').notNull(),
  durationMs: real('duration_ms'),
  summary: text('summary'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [unique('workflow_steps_run_node_uniq').on(table.runId, table.nodeId)]);

/** PR H: immutable, invocation-scoped structured context records. */
export const contextSnapshots = sqliteTable('context_snapshots', {
  snapshotId: text('snapshot_id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => researchSessions.id, { onDelete: 'cascade' }),
  turnId: text('turn_id').notNull().references(() => researchTurns.id, { onDelete: 'cascade' }),
  workingContextVersion: integer('working_context_version').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  packetFingerprint: text('packet_fingerprint').notNull(),
  packetJson: text('packet_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export const modelCalls = sqliteTable('model_calls', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => executions.id, { onDelete: 'cascade' }),
  turnId: text('turn_id').references(() => researchTurns.id, { onDelete: 'cascade' }),
  stepId: text('step_id').references(() => workflowSteps.id, { onDelete: 'cascade' }),
  contextSnapshotId: text('context_snapshot_id').references(() => contextSnapshots.snapshotId, { onDelete: 'restrict' }),
  subagent: text('subagent').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  providerId: text('provider_id'),
  modelId: text('model_id'),
  adapterId: text('adapter_id'),
  protocol: text('protocol'),
  runtimeFingerprint: text('runtime_fingerprint'),
  attempt: integer('attempt').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cachedInputTokens: integer('cached_input_tokens'),
  totalTokens: integer('total_tokens'),
  latencyMs: real('latency_ms').notNull(),
  finishReason: text('finish_reason'),
  cost: real('cost'),
  currency: text('currency'),
  createdAt: text('created_at').notNull(),
});

export const conversationEvents = sqliteTable('conversation_events', {
  sessionId: text('session_id').notNull().references(() => researchSessions.id),
  sequence: integer('sequence').notNull(),
  createdAt: text('created_at').notNull(),
  payload: text('payload').notNull(),
}, table => [primaryKey({ columns: [table.sessionId, table.sequence] })]);

export const conversationEvidence = sqliteTable('conversation_evidence', {
  sessionId: text('session_id').notNull().references(() => researchSessions.id),
  internalId: text('internal_id').notNull().references(() => evidence.id),
  displayNumber: integer('display_number').notNull(),
}, table => [primaryKey({ columns: [table.sessionId, table.internalId] }), unique().on(table.sessionId, table.displayNumber)]);

/**
 * PR D: durable versioned working context. One row per committed version; the
 * payload keeps the structured state so no working-context property needs its own
 * table before a query requirement exists.
 */
export const sessionContextVersions = sqliteTable('session_context_versions', {
  sessionId: text('session_id').notNull().references(() => researchSessions.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  sourceSequence: integer('source_sequence').notNull(),
  payloadJson: text('payload_json').notNull(),
  updatedByTurnId: text('updated_by_turn_id').references(() => researchTurns.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, table => [primaryKey({ columns: [table.sessionId, table.version] })]);
