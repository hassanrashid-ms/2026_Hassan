import { Router } from 'express'
import { resolutionAnswerHandler } from '../controllers/resolutionController.ts'

export const resolutionRouter = Router()
resolutionRouter.post('/resolution-answer', resolutionAnswerHandler)
