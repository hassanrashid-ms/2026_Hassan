import type { RequestHandler } from 'express'
import { ChangeLogHistoryQuery, SaveBotConfigBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { EmptyBotPrompt } from '../../domain/bot/botConfig.ts'
import { decodeChangeLogCursor } from '../../shared/changeLog/cursor.ts'
import { getBotConfigView, listBotConfigHistory, saveBotConfigForAgent } from '../services/botConfigService.ts'

export const getBotConfigHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await getBotConfigView(req.agent!))
}

/**
 * 200, not 201: the row is upserted and a first save is not a new addressable
 * resource — GET /agent/bot-config already answers for a workspace with no row.
 *
 * EmptyBotPrompt is caught here rather than mapped in errorMiddleware because its
 * message names the offending COLUMN, which is the whole point of the error, and
 * the generic 500 path would discard it.
 */
export const saveBotConfigHandler: RequestHandler = async (req, res) => {
  const body = SaveBotConfigBody.safeParse(req.body)
  if (!body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'At least one of is_provisioned, prompt or rules is required, and no other field is accepted.',
    )
    return
  }

  try {
    res.status(200).json(
      await saveBotConfigForAgent(req.agent!, {
        isProvisioned: body.data.is_provisioned,
        prompt: body.data.prompt,
        rules: body.data.rules,
      }),
    )
  } catch (error) {
    if (error instanceof EmptyBotPrompt) {
      sendError(res, 422, 'invalid_request', error.message)
      return
    }
    throw error
  }
}

/**
 * A cursor that will not decode is a client mistake — a hand-edited or stale
 * bookmark — so it is a 422, not a silent first page. Silently ignoring it would
 * make a paging bug look like duplicate data.
 */
export const getBotConfigHistoryHandler: RequestHandler = async (req, res) => {
  const query = ChangeLogHistoryQuery.safeParse(req.query)
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'limit must be an integer between 1 and 200.')
    return
  }

  const cursor = query.data.cursor === undefined ? undefined : decodeChangeLogCursor(query.data.cursor)
  if (cursor === null) {
    sendError(res, 422, 'invalid_request', 'cursor is not a valid page cursor.')
    return
  }

  res.status(200).json(await listBotConfigHistory(req.agent!, { limit: query.data.limit, cursor }))
}
