import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { resolutionCycle } from '../src/shared/db/schema/index.ts'
import {
  INACTIVITY_WINDOW_HOURS,
  closeResolutionCycle,
  nextInactivityDueAt,
  openResolutionCycle,
  pauseInactivityClock,
  resumeInactivityClock,
  stampCycleClosed,
  touchInactivityClock,
} from '../src/domain/conversations/index.ts'
import { closeOwnerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

const NOW = new Date('2026-08-18T12:00:00Z')
const plus24h = new Date(NOW.getTime() + 24 * 3_600_000)

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function fixture() {
  const workspaceId = await seedWorkspace({ slug: 'demo-game' })
  const playerId = await seedPlayer(workspaceId)
  const conversationId = await seedConversation({ workspaceId, playerId })
  return { workspaceId, playerId, conversationId }
}

const cycles = (workspaceId: string, conversationId: string) =>
  withWorkspace(workspaceId, async (tx) =>
    tx
      .select()
      .from(resolutionCycle)
      .where(eq(resolutionCycle.conversationId, conversationId))
      .orderBy(desc(resolutionCycle.cycleNo)),
  )

describe('resolutionCycle helper', () => {
  it('exposes a 24 hour window', () => {
    expect(INACTIVITY_WINDOW_HOURS).toBe(24)
    expect(nextInactivityDueAt(NOW).toISOString()).toBe(plus24h.toISOString())
  })

  it('opens cycle 1 with a null clock, then cycle 2 on the next open', async () => {
    const { workspaceId, conversationId } = await fixture()

    const first = await withWorkspace(workspaceId, (tx) => openResolutionCycle(tx, { workspaceId, conversationId }))
    expect(first.cycleNo).toBe(1)

    await withWorkspace(workspaceId, (tx) => closeResolutionCycle(tx, { conversationId, kind: 'bot', now: NOW }))
    const second = await withWorkspace(workspaceId, (tx) => openResolutionCycle(tx, { workspaceId, conversationId }))
    expect(second.cycleNo).toBe(2)

    const rows = await cycles(workspaceId, conversationId)
    expect(rows.map((r) => r.cycleNo)).toEqual([2, 1])
    expect(rows[0]!.inactivityDueAt).toBeNull()
    expect(rows[1]!.resolutionKind).toBe('bot')
  })

  it('refuses a second open cycle on the same conversation', async () => {
    const { workspaceId, conversationId } = await fixture()
    await withWorkspace(workspaceId, (tx) => openResolutionCycle(tx, { workspaceId, conversationId }))
    await expect(
      withWorkspace(workspaceId, (tx) => openResolutionCycle(tx, { workspaceId, conversationId })),
    ).rejects.toThrow()
  })

  it('touch sets the due date 24h out, pause nulls it, resume sets it again', async () => {
    const { workspaceId, conversationId } = await fixture()
    await withWorkspace(workspaceId, (tx) => openResolutionCycle(tx, { workspaceId, conversationId }))

    await withWorkspace(workspaceId, (tx) => touchInactivityClock(tx, { conversationId, now: NOW }))
    expect((await cycles(workspaceId, conversationId))[0]!.inactivityDueAt!.toISOString()).toBe(plus24h.toISOString())

    await withWorkspace(workspaceId, (tx) => pauseInactivityClock(tx, { conversationId }))
    expect((await cycles(workspaceId, conversationId))[0]!.inactivityDueAt).toBeNull()

    await withWorkspace(workspaceId, (tx) => resumeInactivityClock(tx, { conversationId, now: NOW }))
    expect((await cycles(workspaceId, conversationId))[0]!.inactivityDueAt!.toISOString()).toBe(plus24h.toISOString())
  })

  it('close stamps resolved_at and kind and stops the clock', async () => {
    const { workspaceId, conversationId } = await fixture()
    await withWorkspace(workspaceId, (tx) => openResolutionCycle(tx, { workspaceId, conversationId }))
    await withWorkspace(workspaceId, (tx) => touchInactivityClock(tx, { conversationId, now: NOW }))

    await withWorkspace(workspaceId, (tx) =>
      closeResolutionCycle(tx, { conversationId, kind: 'timed_out', now: NOW }),
    )

    const [row] = await cycles(workspaceId, conversationId)
    expect(row!.resolvedAt!.toISOString()).toBe(NOW.toISOString())
    expect(row!.resolutionKind).toBe('timed_out')
    expect(row!.inactivityDueAt).toBeNull()
  })

  it('never touches or closes an already-resolved cycle', async () => {
    const { workspaceId, conversationId } = await fixture()
    await withWorkspace(workspaceId, (tx) => openResolutionCycle(tx, { workspaceId, conversationId }))
    await withWorkspace(workspaceId, (tx) => closeResolutionCycle(tx, { conversationId, kind: 'bot', now: NOW }))

    const later = new Date(NOW.getTime() + 3_600_000)
    await withWorkspace(workspaceId, (tx) => touchInactivityClock(tx, { conversationId, now: later }))
    await withWorkspace(workspaceId, (tx) => closeResolutionCycle(tx, { conversationId, kind: 'agent', now: later }))

    const [row] = await cycles(workspaceId, conversationId)
    expect(row!.inactivityDueAt).toBeNull()
    expect(row!.resolutionKind).toBe('bot')
    expect(row!.resolvedAt!.toISOString()).toBe(NOW.toISOString())
  })

  it('stampCycleClosed marks the newest cycle closed and is write-once', async () => {
    const { workspaceId, conversationId } = await fixture()
    await withWorkspace(workspaceId, (tx) => openResolutionCycle(tx, { workspaceId, conversationId }))

    await withWorkspace(workspaceId, (tx) => stampCycleClosed(tx, { conversationId, now: NOW }))
    const later = new Date(NOW.getTime() + 3_600_000)
    await withWorkspace(workspaceId, (tx) => stampCycleClosed(tx, { conversationId, now: later }))

    const [row] = await cycles(workspaceId, conversationId)
    expect(row!.closedAt!.toISOString()).toBe(NOW.toISOString())
  })

  it('does nothing when the conversation has no open cycle', async () => {
    const { workspaceId, conversationId } = await fixture()
    await withWorkspace(workspaceId, (tx) => touchInactivityClock(tx, { conversationId, now: NOW }))
    await withWorkspace(workspaceId, (tx) => closeResolutionCycle(tx, { conversationId, kind: 'bot', now: NOW }))
    await withWorkspace(workspaceId, (tx) => stampCycleClosed(tx, { conversationId, now: NOW }))
    expect(await cycles(workspaceId, conversationId)).toHaveLength(0)
  })
})
