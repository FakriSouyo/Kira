-- PR O: durable resumability lifecycle, immutable execution profiles, and node outputs.
CREATE TABLE executions_pr_o (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES research_sessions(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES research_turns(id) ON DELETE CASCADE,
  attempt INTEGER,
  ticker TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'interrupted', 'completed', 'failed', 'cancelled')),
  execution_time REAL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  resume_generation INTEGER NOT NULL DEFAULT 0 CHECK(resume_generation >= 0)
);

INSERT INTO executions_pr_o (
  id, session_id, turn_id, attempt, ticker, command, status,
  execution_time, error, created_at, completed_at, resume_generation
)
SELECT id, session_id, turn_id, attempt, ticker, command, status,
  execution_time, error, created_at, completed_at, 0
FROM executions;

DROP TABLE executions;
ALTER TABLE executions_pr_o RENAME TO executions;

CREATE INDEX idx_executions_session ON executions(session_id, created_at);
CREATE INDEX idx_executions_turn ON executions(turn_id, created_at);
CREATE INDEX idx_executions_ticker ON executions(ticker);
CREATE INDEX idx_executions_status ON executions(status);
CREATE INDEX idx_executions_created ON executions(created_at DESC);
CREATE UNIQUE INDEX executions_turn_attempt_uniq
  ON executions(turn_id, attempt)
  WHERE turn_id IS NOT NULL;

CREATE TABLE execution_profiles (
  execution_id TEXT PRIMARY KEY REFERENCES executions(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  graph_fingerprint TEXT NOT NULL CHECK(length(graph_fingerprint) = 64),
  command TEXT NOT NULL,
  ticker TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
  created_at TEXT NOT NULL
);

CREATE TABLE workflow_node_outputs (
  output_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('completed', 'skipped')),
  output_kind TEXT NOT NULL,
  dependency_fingerprint TEXT NOT NULL CHECK(length(dependency_fingerprint) = 64),
  output_fingerprint TEXT NOT NULL CHECK(length(output_fingerprint) = 64),
  payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json)),
  completion_generation INTEGER NOT NULL CHECK(completion_generation >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(execution_id, node_id)
);

CREATE INDEX workflow_node_outputs_execution_idx ON workflow_node_outputs(execution_id, created_at);
