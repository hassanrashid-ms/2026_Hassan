import { Router } from 'express'
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts'
import { requireWorkspaceRole } from '../../shared/middleware/requireWorkspaceRole.ts'
import {
  archiveFormHandler,
  createFormHandler,
  getFormHandler,
  listFormsHandler,
  publishFormHandler,
  setFormSubintentsHandler,
  updateFormHandler,
} from '../controllers/formsController.ts'

/**
 * The spec's routes use PATCH for edit/mapping. app.ts's CORS allows only
 * GET and POST (same reasoning as botConfigRouter's save route), so both
 * mutating-an-existing-resource routes fall back to POST with a verb suffix
 * instead: `/forms/:id/update` and `/forms/:id/subintents/set`.
 */
const canBuildForms = requireWorkspaceRole('team_lead', 'admin')

export const formsRouter = Router()
formsRouter.get('/forms', canBuildForms, listFormsHandler)
formsRouter.post('/forms', canBuildForms, createFormHandler)
formsRouter.get('/forms/:id', canBuildForms, getFormHandler)
formsRouter.post('/forms/:id/update', canBuildForms, updateFormHandler)
formsRouter.post('/forms/:id/publish', requireAdminRole, publishFormHandler)
formsRouter.post('/forms/:id/archive', requireAdminRole, archiveFormHandler)
formsRouter.post('/forms/:id/subintents/set', canBuildForms, setFormSubintentsHandler)
