-- Keep both API counts, including fractional item-adjusted game counts.
CREATE TABLE stompers_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stompers_uid TEXT NOT NULL UNIQUE,
  username TEXT,
  updated_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_synced_at INTEGER,
  last_error TEXT
);

CREATE TABLE stompers_games (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  game_uid TEXT NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE step_entries_new (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  steps REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'admin', 'stompers')),
  updated_at INTEGER NOT NULL,
  raw_steps REAL,
  game_steps REAL,
  stompers_game_uid TEXT,
  stompers_synced_at INTEGER,
  PRIMARY KEY (user_id, date)
);
INSERT INTO step_entries_new (user_id, date, steps, source, updated_at)
  SELECT user_id, date, steps, source, updated_at FROM step_entries;
DROP TABLE step_entries;
ALTER TABLE step_entries_new RENAME TO step_entries;
