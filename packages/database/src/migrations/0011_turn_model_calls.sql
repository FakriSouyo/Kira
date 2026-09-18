-- PR I: allow a conversational ModelCall to belong directly to a canonical Turn.
-- Existing workflow calls retain their execution/step ownership.
CREATE TABLE model_calls_pr_i (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES executions(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES research_turns(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES workflow_steps(id) ON DELETE CASCADE,
  context_snapshot_id TEXT REFERENCES context_snapshots(snapshot_id) ON DELETE RESTRICT,
  subagent TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_input_tokens INTEGER,
  total_tokens INTEGER,
  latency_ms REAL NOT NULL,
  finish_reason TEXT,
  cost REAL,
  currency TEXT,
  created_at TEXT NOT NULL,
  CHECK ((run_id IS NOT NULL AND turn_id IS NULL AND step_id IS NOT NULL)
      OR (run_id IS NULL AND turn_id IS NOT NULL AND step_id IS NULL))
);

INSERT INTO model_calls_pr_i (
  id, run_id, turn_id, step_id, context_snapshot_id, subagent, provider, model,
  attempt, input_tokens, output_tokens, cached_input_tokens, total_tokens,
  latency_ms, finish_reason, cost, currency, created_at
)
SELECT id, run_id, NULL, step_id, context_snapshot_id, subagent, provider, model,
  attempt, input_tokens, output_tokens, cached_input_tokens, total_tokens,
  latency_ms, finish_reason, cost, currency, created_at
FROM model_calls;

DROP TABLE model_calls;
ALTER TABLE model_calls_pr_i RENAME TO model_calls;

CREATE INDEX idx_model_calls_run ON model_calls(run_id, created_at);
CREATE INDEX idx_model_calls_turn ON model_calls(turn_id, created_at);
CREATE INDEX model_calls_context_snapshot_idx ON model_calls(context_snapshot_id);
