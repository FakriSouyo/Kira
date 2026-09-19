-- PR N: immutable execution-scoped verified financial inputs.
CREATE TABLE financial_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES research_turns(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
  created_at TEXT NOT NULL,
  finalized_at TEXT NOT NULL,
  UNIQUE(execution_id)
);

CREATE INDEX financial_snapshots_session_idx ON financial_snapshots(session_id, created_at);
CREATE INDEX financial_snapshots_turn_idx ON financial_snapshots(turn_id, created_at);
