import { Router } from 'express'
import { bootstrap } from '../controllers/bootstrapController.ts'

export const bootstrapRouter = Router()
bootstrapRouter.get('/bootstrap', bootstrap)
