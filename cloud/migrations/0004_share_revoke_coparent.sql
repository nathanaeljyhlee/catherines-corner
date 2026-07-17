-- Catherine's Corner — Stage 2, v1.15 migration (share-link revocation +
-- resumable guest upload + owner-approved co-parent join). Fully additive and
-- idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), safe to re-run.
--
-- 1. share_link.revoked_at  — a cancelled link reads as a calm 404 forever.
-- 2. family_member.status   — the SECURITY CORE. Existing rows backfill to
--    'active' via DEFAULT; a co-parent lands 'pending' and sees NOTHING until
--    the owner approves (resolveFamily requires status = 'active').
-- 3. family_invite          — owner-minted join links (token = urlToken(),
--    NOT a uuid), single-use (used_at), 14-day expiry.

ALTER TABLE share_link    ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

ALTER TABLE family_member ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';  -- existing rows backfill to 'active'

CREATE TABLE IF NOT EXISTS family_invite (
  token       text PRIMARY KEY,
  family_id   text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  created_by  uuid NOT NULL REFERENCES account(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE INDEX IF NOT EXISTS family_member_pending ON family_member (family_id) WHERE status = 'pending';
