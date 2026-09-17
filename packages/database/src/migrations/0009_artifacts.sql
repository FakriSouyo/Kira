-- PR F: immutable typed artifacts produced from completed canonical executions.
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('BULL_CASE', 'BEAR_CASE', 'VERDICT')),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES research_turns(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  UNIQUE(execution_id, kind)
);

CREATE INDEX artifacts_execution_idx ON artifacts(execution_id, kind);
CREATE INDEX artifacts_session_idx ON artifacts(session_id, created_at);
