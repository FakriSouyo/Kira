CREATE TABLE research_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE research_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE REFERENCES executions(id) ON DELETE CASCADE,
  input TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_research_turns_session ON research_turns(session_id, started_at);

CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  parent_node_ids TEXT NOT NULL,
  subagent TEXT,
  skills TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms REAL,
  summary TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(run_id, node_id)
);

CREATE INDEX idx_workflow_steps_run ON workflow_steps(run_id, created_at);

CREATE TABLE model_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
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
  created_at TEXT NOT NULL
);

CREATE INDEX idx_model_calls_run ON model_calls(run_id, created_at);
