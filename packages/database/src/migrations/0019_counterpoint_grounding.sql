CREATE TABLE counterpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  counterpoint_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL CHECK(source_node_id IN ('round-1-bear-challenge', 'conditional-bear-rechallenge')),
  target_claim_id TEXT NOT NULL,
  argument TEXT NOT NULL,
  strength TEXT NOT NULL CHECK(strength IN ('high', 'moderate', 'low')),
  evidence_ids TEXT NOT NULL,
  cited_figures TEXT,
  evidence_links TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, counterpoint_id)
);

CREATE INDEX counterpoints_run_source_idx ON counterpoints(run_id, source_node_id, counterpoint_id);
