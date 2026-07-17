// Apply cloud/migrations/*.sql to Neon and assert the expected tables exist.
// Uses the DIRECT (non-pooled) connection for DDL. Connection string from env
// (injected by op at runtime); never hardcoded.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const __dir = dirname(fileURLToPath(import.meta.url))
const migDir = join(__dir, '..', 'migrations')
const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL
if (!url) { console.error('no DATABASE_URL_DIRECT/DATABASE_URL in env'); process.exit(1) }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await client.connect()

for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
  console.log('applying', f)
  await client.query(readFileSync(join(migDir, f), 'utf8'))
}

const need = ['account', 'backup_state', 'blob_object', 'family', 'family_member', 'inbox_item', 'invite', 'share_link']
const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
const got = new Set(rows.map((r) => r.tablename))
console.log('tables present:', [...got].join(', '))
const missing = need.filter((t) => !got.has(t))
await client.end()
if (missing.length) { console.error('MISSING TABLES:', missing.join(', ')); process.exit(2) }
console.log('MIGRATION OK: all', need.length, 'expected tables present')
