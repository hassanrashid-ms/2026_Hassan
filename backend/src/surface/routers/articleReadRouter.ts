import { Router } from 'express'
import { articleRead } from '../controllers/articleReadController.ts'

export const articleReadRouter = Router()
articleReadRouter.post('/events/article_read', articleRead)
