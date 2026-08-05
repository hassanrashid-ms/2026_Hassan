import type { RequestHandler } from 'express'
import { and, eq } from 'drizzle-orm'
import { ArticleReadBody } from '@support/types'
import { sendError } from '../errors.ts'
import { appendEvent } from '../events/appendEvent.ts'
import { session } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'

/**
 * The player browses articles inside the webview, so the web app writes one
 * article_read event per article opened, against the authenticated session.
 *
 * This is what p40's funnel counts and what "articles read per session" divides by.
 * It is NOT article_feedback: reading an article and answering "did this help?" are
 * separate signals, and that second one arrives with the article UI.
 *
 * No dedupe: three reads of the same article are three events. The funnel counts
 * distinct sessions and the average counts events; collapsing them here would lose
 * the second.
 */
export const articleRead: RequestHandler = async (req, res) => {
  const ctx = req.player!

  const body = ArticleReadBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid and article_id must be present.')
    return
  }

  const wrote = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [owned] = await tx
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.id, body.data.session_id), eq(session.playerId, ctx.playerId)))
      .limit(1)

    if (!owned) return false

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'article_read',
      sessionId: owned.id,
      actorId: ctx.playerId,
      actorType: 'player',
      // Snapshotted, not a FK: the article table does not exist yet, and once it
      // does, an event must record what happened rather than point at live content.
      payload: { article_id: body.data.article_id },
    })
    return true
  })

  if (!wrote) {
    sendError(res, 404, 'not_found', 'Session not found.')
    return
  }

  res.status(200).json({ ok: true })
}
