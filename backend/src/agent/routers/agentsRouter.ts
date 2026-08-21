import { Router } from 'express'
import { listAgentsHandler } from '../controllers/agentsController.ts'

export const agentsRouter = Router()

agentsRouter.get('/agents', listAgentsHandler)
