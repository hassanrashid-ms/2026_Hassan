import { randomUUID } from 'node:crypto'
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

export async function seedWorkspace(
  overrides: { id?: string; slug?: string; name?: string; secretHash?: string; disabledAt?: Date | null } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID()
  const slug = overrides.slug ?? `ws-${id.slice(0, 8)}`
  await ownerPool.query(
    `insert into workspace (id, name, slug, secret_hash, disabled_at) values ($1, $2, $3, $4, $5)`,
    [id, overrides.name ?? slug, slug, overrides.secretHash ?? 'unset', overrides.disabledAt ?? null],
  )
  return id
}

export async function seedAgent(email = `a-${randomUUID().slice(0, 8)}@example.test`): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into agent (id, email, display_name) values ($1, $2, 'Test Agent')`,
    [id, email],
  )
  return id
}

export async function seedPlayer(workspaceId: string, externalId = `p-${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into player (id, workspace_id, external_id) values ($1, $2, $3)`,
    [id, workspaceId, externalId],
  )
  return id
}

export async function seedDeclaredFields(workspaceId: string, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await ownerPool.query(
      `insert into declared_field (workspace_id, key, label, type) values ($1, $2, $2, 'string')
         on conflict (workspace_id, key) do nothing`,
      [workspaceId, key],
    )
  }
}

export async function seedSession(args: {
  workspaceId: string
  playerId: string
  id?: string
  entryPoint?: string
  startedAt?: Date
  endedAt?: Date | null
}): Promise<string> {
  const id = args.id ?? randomUUID()
  await ownerPool.query(
    `insert into session (id, workspace_id, player_id, entry_point, started_at, ended_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      args.workspaceId,
      args.playerId,
      args.entryPoint ?? 'settings_menu',
      args.startedAt ?? new Date(),
      args.endedAt ?? null,
    ],
  )
  return id
}

export async function seedConversation(args: {
  workspaceId: string
  playerId: string
  sessionId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into conversation (id, workspace_id, player_id, session_id) values ($1, $2, $3, $4)`,
    [id, args.workspaceId, args.playerId, args.sessionId ?? null],
  )
  return id
}

export async function seedMessage(args: {
  workspaceId: string
  conversationId: string
  seq: number
  authorType: 'player' | 'agent' | 'bot' | 'system'
  visibility?: 'public' | 'internal'
  deliveryState?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
  body?: string
}): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into message (id, workspace_id, conversation_id, seq, author_type, visibility, delivery_state, body)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      args.workspaceId,
      args.conversationId,
      args.seq,
      args.authorType,
      args.visibility ?? 'public',
      args.deliveryState ?? 'sent',
      args.body ?? 'test message',
    ],
  )
  return id
}
