CREATE TABLE attachments (
  attachment_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES research_turns(id) ON DELETE CASCADE,
  filename TEXT NOT NULL CHECK(length(filename) > 0),
  media_type TEXT CHECK(media_type IS NULL OR length(media_type) > 0),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  content_hash TEXT NOT NULL CHECK(
    length(content_hash) = 64
    AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL
);

CREATE INDEX attachments_session_idx ON attachments(session_id, created_at, attachment_id);
CREATE INDEX attachments_turn_idx ON attachments(turn_id, created_at, attachment_id);
CREATE INDEX attachments_content_hash_idx ON attachments(content_hash);
