-- One photo per person: user_id is the primary key, so a second row cannot exist.
-- Kept apart from users so page queries never read image bytes.
CREATE TABLE user_avatars (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  image BLOB NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 65536),
  updated_at INTEGER NOT NULL
);
