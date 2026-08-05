import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { getEnv } from '../../env.ts'
import * as schema from './schema/index.ts'

/** Connects as support_app: a non-owner role with no BYPASSRLS. */
export const pool = new Pool({ connectionString: getEnv().DATABASE_URL, max: 10 })

export const db = drizzle(pool, { schema })
export type Db = typeof db

export async function closeDb(): Promise<void> {
  await pool.end()
}
