-- Shared evidence belongs to every run that used it, including failed runs.
CREATE TABLE run_evidence (
  run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, evidence_id)
);
CREATE INDEX idx_run_evidence_evidence ON run_evidence(evidence_id);
INSERT OR IGNORE INTO run_evidence SELECT run_id, id FROM evidence;

-- Recover historical links where the old writer recorded references in artifacts.
INSERT OR IGNORE INTO run_evidence
SELECT m.run_id, e.id FROM agent_messages m, json_each(m.evidence_ids) j
JOIN evidence e ON e.id = j.value;
INSERT OR IGNORE INTO run_evidence
SELECT m.run_id, e.id FROM agent_messages m,
json_each(CASE WHEN json_valid(m.metadata) THEN json_extract(m.metadata, '$.seenEvidenceIds') ELSE '[]' END) j
JOIN evidence e ON e.id = j.value;
INSERT OR IGNORE INTO run_evidence
SELECT c.run_id, e.id FROM claims c, json_each(c.evidence_ids) j
JOIN evidence e ON e.id = j.value;
