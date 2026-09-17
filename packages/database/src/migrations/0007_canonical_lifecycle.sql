DROP INDEX idx_research_turns_session;
ALTER TABLE research_turns RENAME TO research_turns_legacy;

CREATE TABLE research_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  run_id TEXT,
  input TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

INSERT INTO research_turns (
  id, session_id, run_id, input, command, status, started_at, completed_at
)
SELECT id, session_id, run_id, input, command, status, started_at, completed_at
FROM research_turns_legacy;

CREATE INDEX idx_research_turns_session ON research_turns(session_id, started_at);

CREATE TABLE executions_new (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES research_sessions(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES research_turns(id) ON DELETE CASCADE,
  attempt INTEGER,
  ticker TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
  execution_time REAL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

INSERT INTO executions_new (
  id, session_id, turn_id, attempt, ticker, command, status,
  execution_time, error, created_at, completed_at
)
SELECT
  executions.id,
  research_turns_legacy.session_id,
  research_turns_legacy.id,
  CASE WHEN research_turns_legacy.id IS NULL THEN NULL ELSE 1 END,
  executions.ticker,
  executions.command,
  executions.status,
  executions.execution_time,
  executions.error,
  executions.created_at,
  executions.completed_at
FROM executions
LEFT JOIN research_turns_legacy ON research_turns_legacy.run_id = executions.id;

DROP TABLE executions;
ALTER TABLE executions_new RENAME TO executions;

DROP TABLE research_turns_legacy;

CREATE INDEX idx_executions_session ON executions(session_id, created_at);
CREATE INDEX idx_executions_turn ON executions(turn_id, created_at);
CREATE INDEX idx_executions_ticker ON executions(ticker);
CREATE INDEX idx_executions_status ON executions(status);
CREATE INDEX idx_executions_created ON executions(created_at DESC);
CREATE UNIQUE INDEX executions_turn_attempt_uniq
  ON executions(turn_id, attempt)
  WHERE turn_id IS NOT NULL;
