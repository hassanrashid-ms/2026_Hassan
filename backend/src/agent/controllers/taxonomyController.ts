import type { RequestHandler } from 'express'
import { z } from 'zod'
import { CreateIntentBody, CreateSubintentBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { createIntent, createSubintent, listIntents } from '../services/taxonomyService.ts'

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
