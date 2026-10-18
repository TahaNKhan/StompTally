-- Track consecutive failed pulls so admins are emailed once per outage, not once per attempt.
ALTER TABLE stompers_accounts ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stompers_accounts ADD COLUMN alerted_at INTEGER;
