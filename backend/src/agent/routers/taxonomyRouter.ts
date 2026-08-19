import { Router } from 'express'
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts'
import {
  archiveIntentHandler,
  createIntentHandler,
  createSubintentHandler,
  listIntentsHandler,
  renameIntentHandler,
} from '../controllers/taxonomyController.ts'

export const taxonomyRouter = Router()
taxonomyRouter.get('/intents', listIntentsHandler)
taxonomyRouter.post('/intents', requireAdminRole, createIntentHandler)
taxonomyRouter.patch('/intents/:id', requireAdminRole, renameIntentHandler)
taxonomyRouter.post('/intents/:id/archive', requireAdminRole, archiveIntentHandler)
taxonomyRouter.post('/intents/:id/subintents', requireAdminRole, createSubintentHandler)
