import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { getEnv } from '../../env.ts'

const run = promisify(execFile)
const sqlDir = join(dirname(new URL(import.meta.url).pathname), 'sql')

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
 * Idempotent and ordered: extensions must exist before push (citext is a column
 * type), and the RLS file must run after push so it can see the tables.
 */
export async function setupDatabase(url: string = getEnv().MIGRATION_DATABASE_URL): Promise<void> {
  await runSqlFile(url, '001_extensions.sql')
  await run('pnpm', ['exec', 'drizzle-kit', 'push', '--force'], {
    cwd: join(dirname(new URL(import.meta.url).pathname), '..', '..'),
    env: { ...process.env, MIGRATION_DATABASE_URL: url },
  })
  await runSqlFile(url, '002_rls.sql')
}

if (process.argv[1]?.endsWith('setup.ts')) {
  // dotenv's default override:false means this is a no-op when a caller (e.g. vitest's
  // globalSetup, which loads .env.test itself) already populated process.env, so it's
  // safe to run unconditionally here.
  const { loadRootEnv } = await import('../../env/loadRootEnv.ts')
  loadRootEnv(import.meta.url)
  await setupDatabase()
  console.log('database ready')
}
