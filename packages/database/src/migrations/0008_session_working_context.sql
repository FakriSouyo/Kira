-- PR D (Core Refactor Plan Phase 3): durable versioned working context.
-- Additive only: existing rows and journals are untouched, one row per committed
-- version, previous versions remain readable.
CREATE TABLE session_context_versions (
  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source_sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  updated_by_turn_id TEXT REFERENCES research_turns(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, version)
);

CREATE INDEX idx_session_context_versions_latest ON session_context_versions(session_id, version DESC);
