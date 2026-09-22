CREATE TABLE documents (
  document_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  source_content_hash TEXT NOT NULL CHECK(
    length(source_content_hash) = 64
    AND source_content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  filename TEXT NOT NULL CHECK(length(filename) > 0),
  detected_media_type TEXT NOT NULL,
  extractor_id TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  text_hash TEXT NOT NULL CHECK(
    length(text_hash) = 64
    AND text_hash NOT GLOB '*[^0-9a-f]*'
  ),
  page_count INTEGER CHECK(page_count IS NULL OR page_count >= 0),
  chunk_count INTEGER NOT NULL CHECK(chunk_count >= 0),
  created_by_turn_id TEXT NOT NULL REFERENCES research_turns(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(attachment_id, extractor_id, extractor_version)
);

CREATE TABLE document_chunks (
  chunk_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  text TEXT NOT NULL CHECK(length(text) > 0),
  content_hash TEXT NOT NULL CHECK(
    length(content_hash) = 64
    AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  page_start INTEGER CHECK(page_start IS NULL OR page_start >= 0),
  page_end INTEGER CHECK(page_end IS NULL OR page_end >= 0),
  line_start INTEGER CHECK(line_start IS NULL OR line_start >= 0),
  line_end INTEGER CHECK(line_end IS NULL OR line_end >= 0),
  section TEXT,
  UNIQUE(document_id, ordinal)
);

CREATE INDEX documents_session_idx ON documents(session_id, created_at, document_id);
CREATE INDEX documents_attachment_idx ON documents(attachment_id);
CREATE INDEX document_chunks_document_idx ON document_chunks(document_id, ordinal);
