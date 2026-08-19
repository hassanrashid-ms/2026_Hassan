import { Router } from 'express'
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts'
import {
  archiveIntentHandler,
  archiveSubintentHandler,
  createIntentHandler,
  createSubintentHandler,
  listIntentsHandler,
  mergeSubintentHandler,
  moveSubintentHandler,
  renameIntentHandler,
  renameSubintentHandler,
} from '../controllers/taxonomyController.ts'

export const taxonomyRouter = Router()
taxonomyRouter.get('/intents', listIntentsHandler)
taxonomyRouter.post('/intents', requireAdminRole, createIntentHandler)
taxonomyRouter.patch('/intents/:id', requireAdminRole, renameIntentHandler)
taxonomyRouter.post('/intents/:id/archive', requireAdminRole, archiveIntentHandler)
taxonomyRouter.post('/intents/:id/subintents', requireAdminRole, createSubintentHandler)
taxonomyRouter.patch('/subintents/:id', requireAdminRole, renameSubintentHandler)
taxonomyRouter.post('/subintents/:id/archive', requireAdminRole, archiveSubintentHandler)
taxonomyRouter.post('/subintents/:id/move', requireAdminRole, moveSubintentHandler)
taxonomyRouter.post('/subintents/:id/merge', requireAdminRole, mergeSubintentHandler)
