import type { RequestHandler } from 'express'
import { z } from 'zod'
import { CreateIntentBody, CreateSubintentBody, RenameIntentBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { archiveIntent, createIntent, createSubintent, listIntents, renameIntent } from '../services/taxonomyService.ts'

const IntentIdParams = z.object({ id: z.uuid() })

export const listIntentsHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await listIntents(req.agent!))
}

export const createIntentHandler: RequestHandler = async (req, res) => {
  const body = CreateIntentBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'name is required.')
    return
  }
  res.status(201).json(await createIntent(req.agent!, body.data.name))
}

export const createSubintentHandler: RequestHandler = async (req, res) => {
  const params = IntentIdParams.safeParse(req.params)
  const body = CreateSubintentBody.safeParse(req.body)
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'A valid intent id and name are required.')
    return
  }
  const result = await createSubintent(req.agent!, params.data.id, body.data.name)
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Intent not found.')
    return
  }
  res.status(201).json(result.subintent)
}

export const renameIntentHandler: RequestHandler = async (req, res) => {
  const params = IntentIdParams.safeParse(req.params)
  const body = RenameIntentBody.safeParse(req.body)
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'A valid intent id and name are required.')
    return
  }
  const result = await renameIntent(req.agent!, params.data.id, body.data.name)
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Intent not found.')
      return
    }
    sendError(res, 409, 'name_taken', 'Another intent already has this name.')
    return
  }
  res.status(200).json(result.intent)
}

export const archiveIntentHandler: RequestHandler = async (req, res) => {
  const params = IntentIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid intent id is required.')
    return
  }
  const result = await archiveIntent(req.agent!, params.data.id)
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Intent not found.')
      return
    }
    if (result.reason === 'is_system') {
      sendError(res, 409, 'not_archivable', 'The "Other" intent can never be archived.')
      return
    }
    if (result.reason === 'has_active_subintents') {
      sendError(res, 409, 'not_archivable', 'Archive or move every subintent under this intent first.')
      return
    }
    sendError(res, 409, 'not_archivable', 'A published article still points at this intent.')
    return
  }
  res.status(200).json(result.intent)
}
