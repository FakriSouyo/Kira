ALTER TABLE run_evidence ADD COLUMN policy_id TEXT;
ALTER TABLE run_evidence ADD COLUMN policy_fingerprint TEXT;
ALTER TABLE run_evidence ADD COLUMN candidate_kind TEXT;
ALTER TABLE run_evidence ADD COLUMN source_origin TEXT;
ALTER TABLE run_evidence ADD COLUMN retrieved_at TEXT;
ALTER TABLE run_evidence ADD COLUMN accepted_at TEXT;
ALTER TABLE run_evidence ADD COLUMN valid_at TEXT;
ALTER TABLE run_evidence ADD COLUMN provenance_json TEXT;
