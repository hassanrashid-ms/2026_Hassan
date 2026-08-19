import type { RequestHandler } from 'express'
import { z } from 'zod'
import {
  CreateIntentBody,
  CreateSubintentBody,
  MergeSubintentBody,
  MoveSubintentBody,
  RenameIntentBody,
  RenameSubintentBody,
} from '@support/types'
import { sendError } from '../../errors.ts'
import {
  archiveIntent,
  archiveSubintent,
  createIntent,
  createSubintent,
  listIntents,
  mergeSubintent,
  moveSubintent,
  renameIntent,
  renameSubintent,
} from '../services/taxonomyService.ts'

const IntentIdParams = z.object({ id: z.uuid() })
const SubintentIdParams = z.object({ id: z.uuid() })

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

export const renameSubintentHandler: RequestHandler = async (req, res) => {
  const params = SubintentIdParams.safeParse(req.params)
  const body = RenameSubintentBody.safeParse(req.body)
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'A valid subintent id is required.')
    return
  }
  const result = await renameSubintent(req.agent!, params.data.id, body.data)
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Subintent not found.')
      return
    }
    sendError(res, 409, 'name_taken', 'Another subintent under this intent already has this name.')
    return
  }
  res.status(200).json(result.subintent)
}

export const archiveSubintentHandler: RequestHandler = async (req, res) => {
  const params = SubintentIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid subintent id is required.')
    return
  }
  const result = await archiveSubintent(req.agent!, params.data.id)
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Subintent not found.')
      return
    }
    sendError(res, 409, 'not_archivable', 'The "Other" subintent can never be archived.')
    return
  }
  res.status(200).json(result.subintent)
}

export const moveSubintentHandler: RequestHandler = async (req, res) => {
  const params = SubintentIdParams.safeParse(req.params)
  const body = MoveSubintentBody.safeParse(req.body)
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'A valid subintent id and target intent id are required.')
    return
  }
  const result = await moveSubintent(req.agent!, params.data.id, body.data.intentId)
  if (!result.ok) {
    sendError(res, 404, result.reason === 'not_found' ? 'not_found' : 'not_found', 'Subintent or target intent not found.')
    return
  }
  res.status(200).json(result.subintent)
}

export const mergeSubintentHandler: RequestHandler = async (req, res) => {
  const params = SubintentIdParams.safeParse(req.params)
  const body = MergeSubintentBody.safeParse(req.body)
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'A valid subintent id and merge target id are required.')
    return
  }
  const result = await mergeSubintent(req.agent!, params.data.id, body.data.intoId)
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Subintent not found.')
      return
    }
    if (result.reason === 'target_invalid') {
      sendError(res, 409, 'invalid_value', 'Merge target must be a different, non-archived subintent in this workspace.')
      return
    }
    sendError(res, 409, 'not_archivable', 'The "Other" subintent can never be merged.')
    return
  }
  res.status(200).json(result.subintent)
}
