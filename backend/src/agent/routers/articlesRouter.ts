import { Router } from 'express'
import {
  archiveArticleHandler,
  createArticleHandler,
  getArticleHandler,
  listArticlesHandler,
  publishArticleHandler,
  updateArticleHandler,
  generateKeywordsHandler,
} from '../controllers/articlesController.ts'

export const articlesRouter = Router()
articlesRouter.get('/articles', listArticlesHandler)
articlesRouter.get('/articles/:id', getArticleHandler)
articlesRouter.post('/articles', createArticleHandler)
articlesRouter.patch('/articles/:id', updateArticleHandler)
articlesRouter.post('/articles/:id/publish', publishArticleHandler)
articlesRouter.post('/articles/:id/archive', archiveArticleHandler)
articlesRouter.post('/articles/generate-keywords', generateKeywordsHandler)
