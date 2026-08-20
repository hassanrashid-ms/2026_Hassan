import type { RequestHandler } from 'express'
import { ChangeLogHistoryQuery, RollbackBotConfigBody, SaveBotConfigBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { EmptyBotPrompt, InvalidRulesPayload, InvalidToolsPayload, InvalidLimitsPayload } from '../../domain/bot/botConfig.ts'
import { decodeChangeLogCursor } from '../../shared/changeLog/cursor.ts'
import {
  ChangeLogEntryNotFound,
  ChangeLogFieldMismatch,
  getBotConfigView,
  listBotConfigHistory,
  rollbackBotConfigForAgent,
  saveBotConfigForAgent,
} from '../services/botConfigService.ts'

export const getBotConfigHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await getBotConfigView(req.agent!))
}

export const saveBotConfigHandler: RequestHandler = async (req, res) => {
  const body = SaveBotConfigBody.safeParse(req.body)
  if (!body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'At least one of is_provisioned, prompt, rules, tools_config or limits_config is required.',
    )
    return
  }

  try {
    res.status(200).json(
      await saveBotConfigForAgent(req.agent!, {
        isProvisioned: body.data.is_provisioned,
        prompt: body.data.prompt,
        rules: body.data.rules,
        toolsConfig: body.data.tools_config,
        limitsConfig: body.data.limits_config,
      }),
    )
  } catch (error) {
    if (
      error instanceof EmptyBotPrompt ||
      error instanceof InvalidRulesPayload ||
      error instanceof InvalidToolsPayload ||
      error instanceof InvalidLimitsPayload
    ) {
      sendError(res, 422, 'invalid_request', error.message)
      return
    }
    throw error
  }
}

const HISTORY_FIELDS = new Set(['prompt', 'rules', 'tools_config', 'limits_config', 'is_provisioned'])

export const getBotConfigHistoryHandler: RequestHandler = async (req, res) => {
  const query = ChangeLogHistoryQuery.safeParse(req.query)
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'limit must be an integer between 1 and 200.')
    return
  }

  const rawField = req.query.field
  if (rawField !== undefined && (typeof rawField !== 'string' || !HISTORY_FIELDS.has(rawField))) {
    sendError(res, 422, 'invalid_request', 'field must be one of prompt, rules, tools_config, limits_config, is_provisioned.')
    return
  }

  const cursor = query.data.cursor === undefined ? undefined : decodeChangeLogCursor(query.data.cursor)
  if (cursor === null) {
    sendError(res, 422, 'invalid_request', 'cursor is not a valid page cursor.')
    return
  }

  res.status(200).json(
    await listBotConfigHistory(req.agent!, {
      limit: query.data.limit,
      cursor,
      field: rawField as 'prompt' | 'rules' | 'tools_config' | 'limits_config' | 'is_provisioned' | undefined,
    }),
  )
}

export const rollbackBotConfigHandler: RequestHandler = async (req, res) => {
  const body = RollbackBotConfigBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'field, change_log_id and side are required.')
    return
  }

  try {
    res.status(200).json(
      await rollbackBotConfigForAgent(req.agent!, {
        field: body.data.field,
        changeLogId: body.data.change_log_id,
        side: body.data.side,
      }),
    )
  } catch (error) {
    if (error instanceof ChangeLogEntryNotFound) {
      sendError(res, 404, 'not_found', error.message)
      return
    }
    if (
      error instanceof ChangeLogFieldMismatch ||
      error instanceof InvalidRulesPayload ||
      error instanceof InvalidToolsPayload ||
      error instanceof InvalidLimitsPayload ||
      error instanceof EmptyBotPrompt
    ) {
      sendError(res, 422, 'invalid_request', error.message)
      return
    }
    throw error
  }
}
