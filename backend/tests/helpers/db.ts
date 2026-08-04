import { Pool } from 'pg'
import { getEnv } from '../../src/env.ts'

/**
 * Tests connect as the owner for setup and teardown: TRUNCATE is an owner-only
 * privilege and support_app is deliberately never granted DELETE.
 */
export const ownerPool = new Pool({ connectionString: getEnv().MIGRATION_DATABASE_URL, max: 4 })

const SCOPED_TABLES = [
  'event',
  'message',
  'conversation',
  'player_state_snapshot',
  'declared_field',
  'session',
  'player',
  'workspace_member',
  'agent',
  'workspace',
]

export async function truncateAll(): Promise<void> {
  await ownerPool.query(`truncate table ${SCOPED_TABLES.join(', ')} restart identity cascade`)
}

export async function closeOwnerPool(): Promise<void> {
  await ownerPool.end()
}
