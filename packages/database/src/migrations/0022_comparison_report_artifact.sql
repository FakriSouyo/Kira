CREATE TABLE artifacts_u3b (
  artifact_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('BULL_CASE', 'BEAR_CASE', 'VERDICT', 'RESEARCH_REPORT', 'COMPARISON_REPORT')),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES research_turns(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  UNIQUE(execution_id, kind)
);

INSERT INTO artifacts_u3b (
  artifact_id, kind, schema_version, session_id, turn_id, execution_id, ticker, payload_json, created_at
)
SELECT artifact_id, kind, schema_version, session_id, turn_id, execution_id, ticker, payload_json, created_at
FROM artifacts;

DROP TABLE artifacts;
ALTER TABLE artifacts_u3b RENAME TO artifacts;

CREATE INDEX artifacts_execution_idx ON artifacts(execution_id, kind);
CREATE INDEX artifacts_session_idx ON artifacts(session_id, created_at);
