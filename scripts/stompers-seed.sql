-- One-time links for the five existing StompTally users, verified against live profiles.
-- Match both ID and name so this cannot link unrelated users on another database.
INSERT INTO stompers_accounts (user_id, stompers_uid, username, updated_at)
SELECT id, 'aM1KXoaq6gceTNwMMRS6xO1kqE53', 'dannachen', CAST(strftime('%s','now') AS INTEGER)*1000
FROM users WHERE id='0bb3fc59-dd3e-49b2-92af-3b7ab7079371' AND name='Danna'
ON CONFLICT(user_id) DO NOTHING;
INSERT INTO stompers_accounts (user_id, stompers_uid, username, updated_at)
SELECT id, '6WrlH28NlAd9e6ASVd6efu7Mclz1', 'tahakhan1', CAST(strftime('%s','now') AS INTEGER)*1000
FROM users WHERE id='6826919b-657a-4a51-bd5a-b5612b03c361' AND name='Taha'
ON CONFLICT(user_id) DO NOTHING;
INSERT INTO stompers_accounts (user_id, stompers_uid, username, updated_at)
SELECT id, '796dPs8xbdagqy3jvSdeQXIlkHD3', 'richardngo', CAST(strftime('%s','now') AS INTEGER)*1000
FROM users WHERE id='fdb878cd-b845-4fda-a1c9-ff9b275c6549' AND name='Richard'
ON CONFLICT(user_id) DO NOTHING;
INSERT INTO stompers_accounts (user_id, stompers_uid, username, updated_at)
SELECT id, 'xeMvACopoHQDjgAoR07MMtUlSHP2', 'lishuhe', CAST(strftime('%s','now') AS INTEGER)*1000
FROM users WHERE id='02777a37-655c-4fe0-9fcf-34446d79513d' AND name='Lishu'
ON CONFLICT(user_id) DO NOTHING;
INSERT INTO stompers_accounts (user_id, stompers_uid, username, updated_at)
SELECT id, '5SUwXWrjvUOaSrFJawj8zUtZcgZ2', 'hollystone2', CAST(strftime('%s','now') AS INTEGER)*1000
FROM users WHERE id='a8869c88-1f57-4383-8246-4cd3b5c21516' AND name='Holly'
ON CONFLICT(user_id) DO NOTHING;
