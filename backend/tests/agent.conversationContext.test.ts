import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { getPlayerStateView } from '../src/agent/services/conversationContextService.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedDeclaredFields,
  seedPlayer,
  seedSession,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function seedSnapshot(args: {
  workspaceId: string
  sessionId: string
  declared?: Record<string, unknown>
  raw?: Record<string, unknown>
  isMissing?: boolean
  degradedReason?: string | null
  capturedAt?: Date
}): Promise<void> {
  await ownerPool.query(
    `insert into player_state_snapshot (id, workspace_id, session_id, declared, raw, is_missing, degraded_reason, captured_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      args.workspaceId,
      args.sessionId,
      JSON.stringify(args.declared ?? {}),
      JSON.stringify(args.raw ?? {}),
      args.isMissing ?? false,
      args.degradedReason ?? null,
      args.capturedAt ?? new Date('2026-08-17T10:00:00Z'),
    ],
  )
}

describe('getPlayerStateView', () => {
  it('reports no_session when the conversation carries no session', async () => {
    const workspaceId = await seedWorkspace()
    const view = await withWorkspace(workspaceId, (tx) => getPlayerStateView(tx, workspaceId, null))
    expect(view).toEqual({ status: 'no_session' })
  })

  it('reports not_captured when the session exists but wrote no snapshot', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const sessionId = await seedSession({ workspaceId, playerId })
    const view = await withWorkspace(workspaceId, (tx) => getPlayerStateView(tx, workspaceId, sessionId))
    expect(view).toEqual({ status: 'not_captured' })
  })

  it('reports missing when the snapshot says the provider returned nothing usable', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const sessionId = await seedSession({ workspaceId, playerId })
    await seedSnapshot({ workspaceId, sessionId, isMissing: true })
    const view = await withWorkspace(workspaceId, (tx) => getPlayerStateView(tx, workspaceId, sessionId))
    expect(view).toEqual({ status: 'missing' })
  })

  it('labels and orders declared fields by joining declared_field', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const sessionId = await seedSession({ workspaceId, playerId })
    await seedDeclaredFields(workspaceId, ['player_level', 'platform'])
    await seedSnapshot({
      workspaceId,
      sessionId,
      declared: { platform: 'ios', player_level: 42 },
      raw: { fps: 58 },
    })

    const view = await withWorkspace(workspaceId, (tx) => getPlayerStateView(tx, workspaceId, sessionId))
    if (view.status !== 'captured') throw new Error(`expected captured, got ${view.status}`)

    expect(view.declared.map((f) => f.key)).toEqual(['player_level', 'platform'])
    expect(view.declared[0]).toEqual({ key: 'player_level', label: 'player_level', type: 'string', value: 42 })
    expect(view.raw).toEqual({ fps: 58 })
    expect(view.degraded_reason).toBeNull()
    expect(view.captured_at).toBe('2026-08-17T10:00:00.000Z')
  })

  it('appends a declared key with no declared_field row rather than dropping it', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const sessionId = await seedSession({ workspaceId, playerId })
    await seedDeclaredFields(workspaceId, ['platform'])
    await seedSnapshot({ workspaceId, sessionId, declared: { orphan_key: 'x', platform: 'android' } })

    const view = await withWorkspace(workspaceId, (tx) => getPlayerStateView(tx, workspaceId, sessionId))
    if (view.status !== 'captured') throw new Error(`expected captured, got ${view.status}`)

    expect(view.declared.map((f) => f.key)).toEqual(['platform', 'orphan_key'])
    expect(view.declared[1]).toEqual({ key: 'orphan_key', label: 'orphan_key', type: 'string', value: 'x' })
  })

  it('surfaces degraded_reason on a captured snapshot', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const sessionId = await seedSession({ workspaceId, playerId })
    await seedSnapshot({ workspaceId, sessionId, degradedReason: 'provider threw on total_spend' })

    const view = await withWorkspace(workspaceId, (tx) => getPlayerStateView(tx, workspaceId, sessionId))
    if (view.status !== 'captured') throw new Error(`expected captured, got ${view.status}`)
    expect(view.degraded_reason).toBe('provider threw on total_spend')
  })

  it('does not fall back to another session snapshot', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const thisSession = await seedSession({ workspaceId, playerId, startedAt: new Date('2026-01-01T00:00:00Z') })
    const laterSession = await seedSession({ workspaceId, playerId, startedAt: new Date('2026-06-01T00:00:00Z') })
    await seedSnapshot({ workspaceId, sessionId: laterSession, declared: { player_level: 99 } })

    const view = await withWorkspace(workspaceId, (tx) => getPlayerStateView(tx, workspaceId, thisSession))
    expect(view).toEqual({ status: 'not_captured' })
  })
})
