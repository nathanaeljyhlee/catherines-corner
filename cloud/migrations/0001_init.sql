-- Catherine's Corner — Stage 2 backend, first migration (Phase 0)
-- Per ADR-0001 (Neon + R2) and build/stage2-cloud-implementation-plan.md §2.
-- Full row-level mirroring of the 7 local tables is deliberately deferred to Phase 5;
-- this is the account + family + blob-manifest + share/inbox surface.
--
-- Phase 0 deviation (documented): account.owner linkage is present but family.owner_account_id
-- is NULLABLE so the backend can prove blob/backup round-trips before Neon Auth is wired (Phase 1).

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  text UNIQUE,           -- Neon Auth subject (wired Phase 1)
  email         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE TABLE IF NOT EXISTS family (
  id                text PRIMARY KEY,   -- the existing CC-XXXX-XXXX corner id, claimed at first push
  owner_account_id  uuid REFERENCES account(id),  -- nullable in Phase 0 (see header)
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE TABLE IF NOT EXISTS family_member (
  family_id   text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, account_id)
);

CREATE TABLE IF NOT EXISTS blob_object (
  family_id   text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  sha256      text NOT NULL,
  bytes       bigint NOT NULL,
  mime        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, sha256)       -- content-addressed WITHIN a family (dedup + integrity)
);

CREATE TABLE IF NOT EXISTS backup_state (
  family_id        text PRIMARY KEY REFERENCES family(id) ON DELETE CASCADE,
  manifest_key     text NOT NULL,
  manifest_sha256  text,
  device_label     text,
  pushed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS share_link (
  token         text PRIMARY KEY,
  family_id     text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'parcel',
  manifest_key  text,
  title         text,
  to_family_id  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  claimed_at    timestamptz
);

CREATE TABLE IF NOT EXISTS invite (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  kid_name    text,
  book_title  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  revoked_at  timestamptz
);

CREATE TABLE IF NOT EXISTS inbox_item (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  invite_id    uuid REFERENCES invite(id) ON DELETE SET NULL,
  blob_sha256  text NOT NULL,
  mime         text,
  from_name    text,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz
);

CREATE INDEX IF NOT EXISTS inbox_family_open ON inbox_item(family_id) WHERE accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS share_family ON share_link(family_id);
