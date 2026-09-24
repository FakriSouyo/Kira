-- T5: immutable execution-scoped provenance for released Claim Graph projections.
CREATE TABLE claim_graph_release_receipts (
  receipt_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES research_turns(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
  created_at TEXT NOT NULL,
  UNIQUE(execution_id)
);

CREATE INDEX claim_graph_release_session_idx ON claim_graph_release_receipts(session_id, created_at);
CREATE INDEX claim_graph_release_turn_idx ON claim_graph_release_receipts(turn_id, created_at);
