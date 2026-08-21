import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { getEnv } from '../../env.ts'
import { logger } from '../logging/logger.ts'
import * as schema from './schema/index.ts'

/**
 * Connects as crm_admin: BYPASSRLS. Every query run through this client sees
 * every workspace's rows. Import this ONLY from backend/src/admin/** — a
 * non-admin handler reaching for this instead of client.ts's `db` is a tenancy
 * bug, not a style choice.
 */
export const adminPool = new Pool({ connectionString: getEnv().ADMIN_DATABASE_URL, max: 5 })
adminPool.on('error', (err) => {
  logger.error('db.adminPool', `Idle client error: ${err.message}`)
})

export const adminDb = drizzle(adminPool, { schema })

export async function closeAdminDb(): Promise<void> {
  await adminPool.end()
}
