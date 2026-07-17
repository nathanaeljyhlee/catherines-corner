-- Single-use guard for magic-link sign-in tokens: a link works once.
-- The token itself is a short-lived signed JWT; on verify we record its jti so
-- a leaked/replayed link can't be redeemed twice.
CREATE TABLE IF NOT EXISTS magic_used (
  jti      text PRIMARY KEY,
  email    text,
  used_at  timestamptz NOT NULL DEFAULT now()
);
