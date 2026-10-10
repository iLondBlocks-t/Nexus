-- NEXUS initial schema. Timestamps are ISO-8601 UTC strings.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at TEXT NOT NULL
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar')),
  theme TEXT NOT NULL DEFAULT 'midnight' CHECK (theme IN ('midnight', 'light')),
  provider_id TEXT,
  model_id TEXT,
  api_key_ciphertext TEXT,
  auto_approve_edits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  workspace_rel TEXT NOT NULL UNIQUE,
  github_repo TEXT,
  github_branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX projects_owner ON projects(owner_id);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  engine_session_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX agent_sessions_project ON agent_sessions(project_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  mode TEXT NOT NULL DEFAULT 'build',
  content TEXT NOT NULL,
  engine_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'complete',
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_session ON messages(agent_session_id, created_at);

-- Append-only event log. `seq` is the cursor used for reconnect and replay.
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_project_seq ON events(project_id, seq);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  command TEXT,
  network INTEGER NOT NULL DEFAULT 0,
  policy TEXT NOT NULL,
  policy_reason TEXT,
  exit_code INTEGER,
  signal TEXT,
  error TEXT,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX jobs_project ON jobs(project_id, created_at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  ref_job_id TEXT,
  engine_session_id TEXT,
  engine_permission_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX approvals_project ON approvals(project_id, status);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL,
  license TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_project ON artifacts(project_id);

CREATE TABLE github_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_level TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX usage_user_kind ON usage_records(user_id, kind, created_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
