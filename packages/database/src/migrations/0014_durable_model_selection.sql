-- Q2: durable per-session model intent and actual Q1 runtime provenance.
CREATE TABLE session_model_selections (
  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('initial', 'user', 'legacy')),
  selected_at TEXT NOT NULL,
  PRIMARY KEY (session_id, version)
);

CREATE INDEX session_model_selections_current_idx
  ON session_model_selections(session_id, version DESC);

INSERT INTO session_model_selections (session_id, version, provider_id, model_id, source, selected_at)
SELECT id, 1, provider, model, 'legacy', created_at
FROM research_sessions;

ALTER TABLE model_calls ADD COLUMN provider_id TEXT;
ALTER TABLE model_calls ADD COLUMN model_id TEXT;
ALTER TABLE model_calls ADD COLUMN adapter_id TEXT;
ALTER TABLE model_calls ADD COLUMN protocol TEXT;
ALTER TABLE model_calls ADD COLUMN runtime_fingerprint TEXT;
