import type { RequestHandler } from 'express'
import { and, eq } from 'drizzle-orm'
import { SessionStartBody, coerceInstant } from '@support/types'
import { sendError } from '../errors.ts'
import { appendEvent } from '../events/appendEvent.ts'
import { playerStateSnapshot, session } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'
import { loadDeclaredKeys } from '../playerState/declaredKeys.ts'
import { splitSnapshot } from '../playerState/split.ts'
import { headerPayload } from './headers.ts'

/**
 * Non-blocking on the SDK side, so this can land after the web app has already
 * created a conversation. The snapshot is keyed to session_id and a conversation
 * reaches it through conversation.session_id, so a late arrival simply becomes
 * visible — no repair step, no ordering requirement.
 */
export const sessionsStart: RequestHandler = async (req, res) => {
  const player = req.player!

  console.log('[sdk/sessions/start] ▶ received', {
    session_id: req.body?.session_id,
    player_id:  player.externalPlayerId,
    workspace:  player.workspaceId,
    entry_point: req.body?.entry_point,
    has_snapshot: req.body?.snapshot != null,
  })

  const parsed = SessionStartBody.safeParse(req.body)
  if (!parsed.success) {
    // The only 4xx this endpoint has: without a usable session_id there is no
    // primary key to write against. Everything else about the body is recoverable.
    console.warn('[sdk/sessions/start] ✗ invalid body', parsed.error.flatten())
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid.')
    return
  }

  const body = parsed.data
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

  res.status(200).json({ ok: true })
}
