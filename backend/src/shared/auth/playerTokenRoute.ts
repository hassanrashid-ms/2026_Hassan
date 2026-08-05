import { Router } from 'express'
import { PlayerTokenRequest, type PlayerTokenResponse } from '@support/types'
import { and, eq, sql } from 'drizzle-orm'
import { getEnv } from '../../env.ts'
import { sendError } from '../../errors.ts'
import { player, workspace } from '../db/schema/index.ts'
import { withWorkspace, withoutWorkspace } from '../db/withWorkspace.ts'
import { signPlayerToken } from './playerToken.ts'
import { parseWorkspaceSecret, secretMatches } from './workspaceSecret.ts'

export const playerTokenRouter = Router()

/**
 * Called server-to-server by the GAME's backend, which is the only place the
 * workspace secret ever lives. Never called by the SDK.
 *
 * Authentication is checked before the body is validated: a caller with a bad
 * secret must not learn whether their payload was well-formed.
 */
playerTokenRouter.post('/player-token', async (req, res) => {
  const header = req.header('authorization') ?? ''
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    sendError(res, 401, 'unauthorized', 'Expected an Authorization: Bearer <workspace_secret> header.')
    return
  }

  const parsed = parseWorkspaceSecret(rest.join(' ').trim())
  if (!parsed) {
    sendError(res, 401, 'unauthorized', 'Workspace secret is malformed.')
    return
  }

  const [found] = await withoutWorkspace(async (tx) =>
    tx
      .select({ id: workspace.id, secretHash: workspace.secretHash, disabledAt: workspace.disabledAt })
      .from(workspace)
      .where(eq(workspace.slug, parsed.slug))
      .limit(1),
  )

  // Unknown and disabled are both 404, per the wire contract. The slug itself is not
  // a secret — it travels in the X-Support-Workspace header on every SDK request —
  // so a 404 revealing "no such slug" is accepted deliberately: a game backend
  // operator needs 404 to mean "you typed the slug wrong".
  if (!found || !secretMatches(parsed.raw, found.secretHash)) {
    sendError(
      res,
      found ? 401 : 404,
      found ? 'unauthorized' : 'not_found',
      found ? 'Workspace secret is not valid.' : 'Workspace not found.',
    )
    return
  }
  if (found.disabledAt) {
    sendError(res, 404, 'not_found', 'Workspace not found.')
    return
  }

  const body = PlayerTokenRequest.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'external_player_id is missing or malformed.')
    return
  }

  const externalPlayerId = body.data.external_player_id

  // Upsert so a player exists from their first support open.
  const playerId = await withWorkspace(found.id, async (tx) => {
    const [row] = await tx
      .insert(player)
      .values({ workspaceId: found.id, externalId: externalPlayerId })
      .onConflictDoUpdate({
        target: [player.workspaceId, player.externalId],
        set: { lastSeenAt: sql`now()` },
      })
      .returning({ id: player.id })
    if (row) return row.id

    // Defensive: an upsert that returns nothing means the conflict row is invisible,
    // which under RLS would mean a tenancy bug rather than a race.
    const [existing] = await tx
      .select({ id: player.id })
      .from(player)
      .where(and(eq(player.workspaceId, found.id), eq(player.externalId, externalPlayerId)))
      .limit(1)
    if (!existing) throw new Error('player upsert returned no row')
    return existing.id
  })

  const ttl = getEnv().PLAYER_TOKEN_TTL_SECONDS
  const token = await signPlayerToken(
    { workspace_id: found.id, player_id: playerId, external_player_id: externalPlayerId },
    ttl,
  )

  const payload: PlayerTokenResponse = { token, expires_in: ttl }
  res.status(200).json(payload)
})
