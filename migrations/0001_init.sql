-- Stomp Tally schema. Dates are local calendar dates ('YYYY-MM-DD') in the group's timezone.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  threshold_steps INTEGER NOT NULL DEFAULT 10000,
  penalty_cents INTEGER NOT NULL DEFAULT 500,
  skips_per_month INTEGER NOT NULL DEFAULT 3,
  start_date TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE memberships (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  joined_date TEXT NOT NULL,
  left_date TEXT,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE step_entries (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  steps INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'admin')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

-- status: pending until the day is finalized, then consumed (it saved them $5).
-- Claims that turned out not to be needed are deleted at finalize, so they don't count.
CREATE TABLE skip_claims (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id, date)
);

CREATE TABLE day_results (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  min_steps INTEGER,
  loser_ids TEXT NOT NULL,          -- JSON array, everyone tied at the min (if < threshold)
  outcome TEXT NOT NULL CHECK (outcome IN ('no_loser', 'penalty', 'skipped')),
  finalized_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, date)
);

CREATE TABLE penalties (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  cents INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id, date)
);

CREATE TABLE settlements (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  note TEXT,
  settled_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, month)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT,
  actor_id TEXT,
  action TEXT NOT NULL,
  payload TEXT,
  at INTEGER NOT NULL
);
