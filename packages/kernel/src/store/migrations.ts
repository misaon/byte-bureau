export interface Migration {
  readonly id: string
  readonly sql: string
}

// Spec §5.2; one statement per line group so SQLite executes them in order
// The splitter cuts at every `;`, so no statement may hold one inside a literal or a trigger body
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial',
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('login', 'api_key')),
  config_dir TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  employee_json TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  profile_id TEXT REFERENCES profiles(id),
  workspace_json TEXT NOT NULL,
  external_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('created', 'provisioning', 'ready', 'running', 'waiting_for_human', 'paused_usage_limit', 'completed', 'stopped', 'errored')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  parent_session_id TEXT REFERENCES sessions(id)
);
CREATE INDEX sessions_project ON sessions(project_id);
CREATE INDEX sessions_profile ON sessions(profile_id);
CREATE INDEX sessions_parent ON sessions(parent_session_id);
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  idx INTEGER NOT NULL,
  prompt_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'interrupted', 'errored')),
  stop_reason TEXT,
  usage_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (session_id, idx)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_session ON messages(session_id);
CREATE INDEX messages_turn ON messages(turn_id);
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  tool_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('builtin', 'mcp', 'bash', 'subagent', 'skill')),
  input_json TEXT NOT NULL,
  output_summary TEXT,
  input_bytes INTEGER NOT NULL DEFAULT 0,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_type TEXT
);
CREATE INDEX tool_calls_session ON tool_calls(session_id);
CREATE INDEX tool_calls_turn ON tool_calls(turn_id);
CREATE TABLE asks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  kind TEXT NOT NULL CHECK (kind IN ('question', 'permission')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'expired', 'cancelled')),
  answer_json TEXT,
  recommendation_source TEXT NOT NULL CHECK (recommendation_source IN ('agent', 'policy', 'none')),
  created_at TEXT NOT NULL,
  deadline_at TEXT,
  answered_at TEXT,
  answered_via TEXT
);
CREATE INDEX asks_session ON asks(session_id);
CREATE INDEX asks_turn ON asks(turn_id);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  turn_id TEXT,
  work_item_id TEXT,
  trace_id TEXT,
  span_id TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX events_session_seq ON events(session_id, seq);
CREATE INDEX events_project_seq ON events(project_id, seq);
CREATE TABLE usage_snapshots (
  profile_id TEXT NOT NULL,
  five_hour_pct REAL,
  five_hour_resets_at TEXT,
  seven_day_pct REAL,
  seven_day_resets_at TEXT,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE TABLE plugin_kv (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);
`,
  },
  {
    id: '0002_session_env',
    // The BYTEBUREAU_* variables given at creation, read back when a later process resumes the session
    sql: `ALTER TABLE sessions ADD COLUMN env_json TEXT NOT NULL DEFAULT '{}'`,
  },
]
