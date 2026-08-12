import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Client, Pool } from 'pg'
import { getEnv } from '../../env.ts'

const sqlDir = join(dirname(new URL(import.meta.url).pathname), 'sql')
const migrationsFolder = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'drizzle')

async function runSqlFile(url: string, file: string): Promise<void> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(await readFile(join(sqlDir, file), 'utf8'))
  } finally {
    await client.end()
  }
}

/**
 * Extensions, then generated migrations, then RLS. `drizzle-kit push` used to
 * sit in the middle of this: it exits 0 even when its SQL fails (a half-applied
 * schema looked like success), it re-plans the composite FK on every run so it
 * was never idempotent, and `--force` still prompts interactively when adding a
 * unique constraint to a populated table — with no TTY it aborted silently.
 * Committed migrations applied via drizzle-orm's migrator throw on failure and
 * are naturally idempotent, so none of that applies.
 */
export async function setupDatabase(url: string = getEnv().MIGRATION_DATABASE_URL): Promise<void> {
  await runSqlFile(url, '001_extensions.sql')
  const pool = new Pool({ connectionString: url })
  try {
    const db = drizzle(pool)
    await migrate(db, { migrationsFolder })
  } finally {
    await pool.end()
  }
  await runSqlFile(url, '002_rls.sql')
}

if (process.argv[1]?.endsWith('setup.ts')) {
  // dotenv's default override:false means this is a no-op when a caller (e.g. vitest's
  // globalSetup, which loads .env.test itself) already populated process.env, so it's
  // safe to run unconditionally here.
  const { loadRootEnv } = await import('../../env/loadRootEnv.ts')
  loadRootEnv(import.meta.url)
  const { logger } = await import('../logging/logger.ts')
  await setupDatabase()
  logger.info('db', 'database ready')
}
