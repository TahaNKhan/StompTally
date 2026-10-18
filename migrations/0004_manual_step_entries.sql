-- Append-only manual submissions, separate from the current daily score and API counts.
CREATE TABLE manual_step_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES groups(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  steps INTEGER NOT NULL,
  previous_steps REAL,
  previous_source TEXT,
  raw_steps REAL,
  game_steps REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX manual_steps_user_time ON manual_step_entries(user_id, created_at DESC, id DESC);
CREATE INDEX manual_steps_group_time ON manual_step_entries(group_id, created_at DESC, id DESC);
