import { Router } from 'express'
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts'
import { createIntentHandler, createSubintentHandler, listIntentsHandler } from '../controllers/taxonomyController.ts'

export const taxonomyRouter = Router()
taxonomyRouter.get('/intents', listIntentsHandler)
taxonomyRouter.post('/intents', requireAdminRole, createIntentHandler)
taxonomyRouter.post('/intents/:id/subintents', requireAdminRole, createSubintentHandler)
