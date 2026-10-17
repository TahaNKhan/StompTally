-- Read paths now use date ranges instead of substr(date) predicates.
-- Keep this separate from the already-applied initial schema.
CREATE INDEX memberships_user_active ON memberships(user_id, left_date, joined_date);
CREATE INDEX skip_claims_group_date ON skip_claims(group_id, date);
CREATE INDEX penalties_group_date ON penalties(group_id, date);
CREATE INDEX invites_group_pending ON invites(group_id, accepted_at, revoked_at, expires_at);
