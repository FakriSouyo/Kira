-- PR H: immutable structured context snapshots and nullable ModelCall linkage.
CREATE TABLE context_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES research_turns(id) ON DELETE CASCADE,
  working_context_version INTEGER NOT NULL CHECK(working_context_version >= 0),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  packet_fingerprint TEXT NOT NULL CHECK(length(packet_fingerprint) = 64),
  packet_json TEXT NOT NULL CHECK(json_valid(packet_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX context_snapshots_session_idx ON context_snapshots(session_id, created_at);
CREATE INDEX context_snapshots_turn_idx ON context_snapshots(turn_id, created_at);

ALTER TABLE model_calls ADD COLUMN context_snapshot_id TEXT
  REFERENCES context_snapshots(snapshot_id) ON DELETE RESTRICT;

CREATE INDEX model_calls_context_snapshot_idx ON model_calls(context_snapshot_id);
