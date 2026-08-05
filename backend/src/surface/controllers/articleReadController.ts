import type { RequestHandler } from 'express'
import { ArticleReadBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { recordArticleRead } from '../services/articleReadService.ts'

export const articleRead: RequestHandler = async (req, res) => {
  const ctx = req.player!

  const body = ArticleReadBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid and article_id must be present.')
    return
  }

  const wrote = await recordArticleRead(ctx, body.data)

  if (!wrote) {
    sendError(res, 404, 'not_found', 'Session not found.')
    return
  }

  res.status(200).json({ ok: true })
}
