-- Email sign-in CODE (OTP) — the right primitive for a shared family tablet /
-- installed PWA, where a magic LINK opens on the wrong device or in Safari
-- instead of the app. One active code per email; short-lived, single-use,
-- rate-limited by attempt count. The code is stored HASHED, never in plaintext.
CREATE TABLE IF NOT EXISTS auth_code (
  email       text PRIMARY KEY,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  used        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
