import { and, eq, isNull } from 'drizzle-orm'
import { coerceInstant } from '@support/types'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { playerStateSnapshot, session } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import { loadDeclaredKeys } from '../../shared/playerState/declaredKeys.ts'
import { splitSnapshot } from '../../shared/playerState/split.ts'
import { headerPayload } from '../headers.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'
import type { EndSessionInput, StartSessionInput } from '../models/sessionModels.ts'

/**
 * Non-blocking on the SDK side, so this can land after the web app has already
 * created a conversation. The snapshot is keyed to session_id and a conversation
 * reaches it through conversation.session_id, so a late arrival simply becomes
 * visible — no repair step, no ordering requirement.
 */
export async function startSession(player: PlayerContext, body: StartSessionInput): Promise<void> {
  const now = new Date()
  const startedAt = coerceInstant(body.started_at, now)

  await withWorkspace(player.workspaceId, async (tx) => {
    const inserted = await tx
      .insert(session)
      .values({
        id: body.session_id,
        workspaceId: player.workspaceId,
        playerId: player.playerId,
        entryPoint: body.entry_point,
        startedAt,
      })
      .onConflictDoNothing({ target: session.id })
      .returning({ id: session.id })

    const isNewSession = inserted.length > 0

    console.log(
      isNewSession
        ? '[sdk/sessions/start] ✓ new session created'
        : '[sdk/sessions/start] ~ duplicate session_id (Outbox retry or conflict)',
      { session_id: body.session_id },
    )

    if (!isNewSession) {
      // The uuid already exists. It is either a retry from this player's Outbox
      // (expected, not exceptional) or an id that is not theirs.
      //
      // ON CONFLICT (id) DO NOTHING consults the unique index, which RLS does not
      // filter, so it no-ops either way. Only an explicit scoped SELECT can tell the
      // two apart — and without it the snapshot upsert below would target a row
      // belonging to another workspace or another player.
      const [owned] = await tx
        .select({ id: session.id })
        .from(session)
        .where(and(eq(session.id, body.session_id), eq(session.playerId, player.playerId)))
        .limit(1)

      if (!owned) {
        console.warn('[sdk/sessions/start] ✗ session_id conflict — not owned by this player', {
          session_id: body.session_id,
          player_id: player.externalPlayerId,
        })
        await appendEvent(tx, {
          workspaceId: player.workspaceId,
          type: 'sdk_incident',
          actorType: 'system',
          occurredAt: now,
          payload: {
            kind: 'session_id_not_ours',
            session_id: body.session_id,
            ...headerPayload(player),
          },
        })
        return
      }
    }

    const declaredKeys = await loadDeclaredKeys(tx)
    const split = splitSnapshot(body.snapshot, declaredKeys, player.externalPlayerId)

    console.log('[sdk/sessions/start] ✦ snapshot split', {
      session_id:      body.session_id,
      is_missing:      split.isMissing,
      degraded_reason: split.degradedReason,
      declared_keys:   Object.keys(split.declared),
      raw_keys:        Object.keys(split.raw),
      declared:        split.declared,
    })

    // DO NOTHING, not DO UPDATE. The split is permanent: re-splitting a redelivered
    // payload against a newer declared_field set would promote a key retroactively,
    // which the schema spec forbids outright ("no backfill, ever").
    const snapshotInserted = await tx
      .insert(playerStateSnapshot)
      .values({
        workspaceId: player.workspaceId,
        sessionId: body.session_id,
        declared: split.declared,
        raw: split.raw,
        isMissing: split.isMissing,
        degradedReason: split.degradedReason,
        capturedAt: startedAt,
      })
      .onConflictDoNothing({ target: playerStateSnapshot.sessionId })
      .returning({ sessionId: playerStateSnapshot.sessionId })

    console.log(
      snapshotInserted.length > 0
        ? '[sdk/sessions/start] ✓ snapshot written to player_state_snapshot'
        : '[sdk/sessions/start] ~ snapshot skipped — already exists (idempotent)',
      { session_id: body.session_id },
    )

    // Only on a genuinely new session. A second session_start would double-count the
    // self-serve denominator, which is the whole reason this endpoint exists.
    if (isNewSession) {
      await appendEvent(tx, {
        workspaceId: player.workspaceId,
        type: 'session_start',
        sessionId: body.session_id,
        actorId: player.playerId,
        actorType: 'player',
        occurredAt: startedAt,
        payload: {
          entry_point: body.entry_point,
          snapshot_state: split.isMissing ? 'missing' : split.degradedReason ? 'degraded' : 'ok',
          ...headerPayload(player),
        },
      })
    }
  })
}

/**
 * If this never arrives the session simply has no ended_at. Two mitigations exist and
 * both are needed: the session-timeout worker closes it as `timeout`, and self-serve
 * rate counts sessions by started_at, never by ended_at — a missing end must never
 * silently shrink the denominator.
 */
export async function endSession(player: PlayerContext, body: EndSessionInput): Promise<void> {
  const now = new Date()

  await withWorkspace(player.workspaceId, async (tx) => {
    // The predicate carries the whole guard: RLS scopes it to the workspace,
    // player_id scopes it to this player, and `ended_at IS NULL` makes a redelivery
    // a no-op instead of moving the timestamp. Zero rows back means there is nothing
    // to do — unknown session, someone else's session, or already ended.
    const [ended] = await tx
      .update(session)
      .set({ endedAt: now, endedBy: 'client' })
      .where(
        and(
          eq(session.id, body.session_id),
          eq(session.playerId, player.playerId),
          isNull(session.endedAt),
        ),
      )
      .returning({ id: session.id, startedAt: session.startedAt })

    if (!ended) return

    await appendEvent(tx, {
      workspaceId: player.workspaceId,
      type: 'session_end',
      sessionId: ended.id,
      actorId: player.playerId,
      actorType: 'player',
      occurredAt: now,
      payload: {
        ended_by: 'client',
        // Derived is what reporting reads.
        duration_ms_derived: now.getTime() - ended.startedAt.getTime(),
        // Reported is recorded for cross-checking a suspected bug, never aggregated.
        // articles_read is a client-side echo of the article_read events the web
        // surface writes; having both is how a silently dead bridge is detected.
        duration_ms_reported: body.duration_ms,
        conversation_created_reported: body.conversation_created,
        articles_read_reported: body.articles_read,
        ...headerPayload(player),
      },
    })
  })
}
