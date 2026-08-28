import { Router } from 'express';
import {
  getPublicArticleHandler,
  listPublicArticlesHandler,
} from '../controllers/articlesController.ts';

export const articlesRouter = Router();
articlesRouter.get('/articles', listPublicArticlesHandler);
articlesRouter.get('/articles/:id', getPublicArticleHandler);
