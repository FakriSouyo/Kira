-- Fix 0001 UNIQUE(content_hash) → scoped dedup (data, ticker, source).
-- Empty payloads [] with different source/ticker must remain distinct (stores.test.ts),
-- while same data + same ticker/source across runs still dedup.
-- Recreates evidence to relax global uniqueness without losing data.

CREATE TABLE IF NOT EXISTS evidence_new (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  source TEXT NOT NULL,
  source_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  valid_at TEXT,
  data TEXT NOT NULL,
  provenance TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(content_hash, ticker, source)
);

INSERT OR IGNORE INTO evidence_new
  SELECT id, run_id, ticker, source, source_type, content_hash, retrieved_at, valid_at, data, provenance, created_at FROM evidence;

DROP TABLE IF EXISTS evidence;
ALTER TABLE evidence_new RENAME TO evidence;

CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id);
CREATE INDEX IF NOT EXISTS idx_evidence_ticker ON evidence(ticker);
CREATE INDEX IF NOT EXISTS idx_evidence_hash ON evidence(content_hash);
CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence(source, ticker);
