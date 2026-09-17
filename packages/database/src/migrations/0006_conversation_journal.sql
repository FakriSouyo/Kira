CREATE TABLE conversation_events (
  session_id TEXT NOT NULL REFERENCES research_sessions(id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY (session_id, sequence)
);
CREATE TABLE conversation_evidence (
  session_id TEXT NOT NULL REFERENCES research_sessions(id),
  internal_id TEXT NOT NULL REFERENCES evidence(id),
  display_number INTEGER NOT NULL CHECK(display_number > 0),
  PRIMARY KEY (session_id, internal_id),
  UNIQUE(session_id, display_number)
);
