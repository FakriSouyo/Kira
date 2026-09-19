import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATA_DIR_NAME, DB_FILE_NAME, ENV } from '@harness/shared';
import { runMigrations } from './migrations/migrate';
import { EvidenceStoreSqlite } from './evidenceStoreSqlite';
import { ConversationStoreSqlite } from './conversationStoreSqlite';
import { ExecutionStoreSqlite } from './executionStoreSqlite';
import { ClaimStoreSqlite } from './claimStoreSqlite';
import { JudgmentStoreSqlite } from './judgmentStoreSqlite';
import { NormalizedStore } from './normalized';
import { ResearchSessionStoreSqlite } from './researchSessionStoreSqlite';
import { ConversationJournalSqlite } from './conversationJournalSqlite';
import { WorkingContextStoreSqlite } from './workingContextStoreSqlite';
import { ArtifactStoreSqlite } from './artifactStoreSqlite';
import { ContextSnapshotStoreSqlite } from './contextSnapshotStoreSqlite';
import { FinancialSnapshotStoreSqlite } from './financialSnapshotStoreSqlite';
import { ExecutionProfileStoreSqlite } from './executionProfileStoreSqlite';
import { WorkflowNodeOutputStoreSqlite } from './workflowNodeOutputStoreSqlite';

export type Orm = BetterSQLite3Database<Record<string, never>>;

export function resolveDataDir(homeDirOverride?: string): string {
  const fromEnv = process.env[ENV.home];
  return homeDirOverride ?? (fromEnv ? fromEnv : join(homedir(), DATA_DIR_NAME));
}

/** Verifikasi JSON1 tersedia — ekspektasi setup sesuai addendum §10. */
function assertJson1(db: Database.Database): void {
  const row = db.prepare("SELECT json_valid('{\"a\":1}') AS ok").get() as { ok: number };
  if (row.ok !== 1) {
    throw new Error('SQLite build does not have JSON1 enabled — required by finharness');
  }
}

export interface FinharnessDatabase {
  raw: Database.Database;
  orm: Orm;
  evidence: EvidenceStoreSqlite;
  conversation: ConversationStoreSqlite;
  execution: ExecutionStoreSqlite;
  claims: ClaimStoreSqlite;
  judgments: JudgmentStoreSqlite;
  normalized: NormalizedStore;
  sessions: ResearchSessionStoreSqlite;
  journal: ConversationJournalSqlite;
  workingContext: WorkingContextStoreSqlite;
  artifacts: ArtifactStoreSqlite;
  contextSnapshots: ContextSnapshotStoreSqlite;
  financialSnapshots: FinancialSnapshotStoreSqlite;
  executionProfiles: ExecutionProfileStoreSqlite;
  workflowNodeOutputs: WorkflowNodeOutputStoreSqlite;
}

export function openDb(options: { homeDir?: string; verbose?: boolean } = {}): FinharnessDatabase {
  const dir = resolveDataDir(options.homeDir);
  mkdirSync(dir, { recursive: true });

  const raw = new Database(join(dir, DB_FILE_NAME), {
    verbose: options.verbose ? console.log : undefined,
  });

  // WAL mode (addendum §10): readers tidak block writers, crash-safe
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');

  assertJson1(raw);
  runMigrations(raw);

  const orm = drizzle(raw);
  return {
    raw,
    orm,
    evidence: new EvidenceStoreSqlite(orm),
    conversation: new ConversationStoreSqlite(orm),
    execution: new ExecutionStoreSqlite(orm),
    claims: new ClaimStoreSqlite(orm),
    judgments: new JudgmentStoreSqlite(orm),
    normalized: new NormalizedStore(orm),
    sessions: new ResearchSessionStoreSqlite(orm),
    journal: new ConversationJournalSqlite(orm),
    workingContext: new WorkingContextStoreSqlite(orm),
    artifacts: new ArtifactStoreSqlite(orm),
    contextSnapshots: new ContextSnapshotStoreSqlite(orm),
    financialSnapshots: new FinancialSnapshotStoreSqlite(orm),
    executionProfiles: new ExecutionProfileStoreSqlite(orm),
    workflowNodeOutputs: new WorkflowNodeOutputStoreSqlite(orm),
  };
}
