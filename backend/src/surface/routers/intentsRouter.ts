import { Router } from 'express'
import { listPublicIntentsHandler } from '../controllers/intentsController.ts'

export const intentsRouter = Router()
intentsRouter.get('/intents', listPublicIntentsHandler)
