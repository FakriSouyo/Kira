-- Finharness schema v1 (addendum §11)
-- Semua kolom JSON disimpan sebagai TEXT berisi JSON (SQLite tidak punya JSONB;
-- JSON1 tersedia untuk query bila perlu — jalur utama tidak bergantung padanya).

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK(status IN ('running', 'completed', 'failed')),

  execution_time REAL,
  error TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_executions_ticker ON executions(ticker);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_executions_created ON executions(created_at DESC);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,

  ticker TEXT NOT NULL,
  source TEXT NOT NULL,
  source_type TEXT NOT NULL,

  content_hash TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  valid_at TEXT,

  data TEXT NOT NULL,
  provenance TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(content_hash)
);

CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id);
CREATE INDEX IF NOT EXISTS idx_evidence_ticker ON evidence(ticker);
CREATE INDEX IF NOT EXISTS idx_evidence_hash ON evidence(content_hash);
CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence(source, ticker);

-- agent 'bear' & tipe 'challenge'/'response' reserved untuk Phase 1 (addendum §08)
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,

  agent TEXT NOT NULL
    CHECK(agent IN ('researcher', 'bull', 'bear', 'judge')),
  message_type TEXT NOT NULL
    CHECK(message_type IN ('observation', 'claim', 'challenge', 'response', 'decision')),

  content TEXT NOT NULL,
  evidence_ids TEXT NOT NULL,

  metadata TEXT,

  sequence_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(run_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_run ON agent_messages(run_id);
CREATE INDEX IF NOT EXISTS idx_messages_sequence ON agent_messages(run_id, sequence_order);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON agent_messages(agent);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  message_id TEXT,

  claim_id TEXT NOT NULL,
  statement TEXT NOT NULL,
  confidence TEXT NOT NULL
    CHECK(confidence IN ('strong', 'moderate', 'weak')),
  reasoning TEXT,
  evidence_ids TEXT NOT NULL,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(run_id, claim_id)
);

CREATE INDEX IF NOT EXISTS idx_claims_run ON claims(run_id);
CREATE INDEX IF NOT EXISTS idx_claims_message ON claims(message_id);

-- breakdown = 5 kategori rubrik; marketMomentum & risk = null di Phase 0 (addendum §11)
CREATE TABLE IF NOT EXISTS judgments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,

  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  stance TEXT CHECK(stance IN ('bullish', 'bearish', 'neutral')),
  confidence TEXT CHECK(confidence IN ('high', 'moderate', 'low')),

  breakdown TEXT NOT NULL,
  summary TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(run_id)
);

CREATE INDEX IF NOT EXISTS idx_judgments_run ON judgments(run_id);
CREATE INDEX IF NOT EXISTS idx_judgments_ticker ON judgments(ticker);
CREATE INDEX IF NOT EXISTS idx_judgments_score ON judgments(score DESC);
