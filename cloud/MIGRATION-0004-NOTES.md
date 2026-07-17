# Migration 0004 — apply notes (for the orchestrator)

**File:** `cloud/migrations/0004_share_revoke_coparent.sql`

## What it does
- `share_link.revoked_at timestamptz` (nullable) — cancelled links.
- `family_member.status text NOT NULL DEFAULT 'active'` — the security core. **Existing rows backfill to `'active'` automatically** via the column DEFAULT, so every current owner/member keeps full access. A co-parent is inserted `'pending'`.
- `family_invite` table — owner-minted join links (`token` = `urlToken()`, NOT a uuid), single-use (`used_at`), FK to `family(id)` + `account(id)`.
- Partial index `family_member_pending` on pending rows.

## Apply command (orchestrator owns the live apply)
```
cd cloud
op run --env-file=op.env -- npm run migrate
```
(`migrate.mjs` runs every `migrations/*.sql` in sorted order; 0004 sorts last. It uses `DATABASE_URL_DIRECT || DATABASE_URL`.)

## Safety
- **Additive + idempotent.** Uses `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Safe to re-run; safe to run while v1.14 worker is live (old worker ignores the new column/table).
- The `migrate.mjs` table assertion still passes (it checks the base 8 tables; `family_invite` is an extra, not asserted).
- Deviation from the contract's literal SQL: I added `REFERENCES family(id) ON DELETE CASCADE` and `REFERENCES account(id)` to `family_invite` to match the FK style of every other table in `0001_init.sql`. Purely additive integrity, no API-shape impact. Flag if you'd rather have the bare columns.
