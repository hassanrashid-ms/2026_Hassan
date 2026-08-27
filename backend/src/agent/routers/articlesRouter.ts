import { Router } from 'express';
import { requireTeamLeadOrAdmin } from '../../shared/middleware/requireTeamLeadOrAdmin.ts';
import {
  archiveArticleHandler,
  createArticleHandler,
  finalizeArticleAttachmentHandler,
  getArticleHandler,
  listArticlesHandler,
  publishArticleHandler,
  updateArticleHandler,
  generateKeywordsHandler,
} from '../controllers/articlesController.ts';

export const articlesRouter = Router();
articlesRouter.get('/articles', listArticlesHandler);
articlesRouter.get('/articles/:id', getArticleHandler);
articlesRouter.post('/articles', createArticleHandler);
articlesRouter.patch('/articles/:id', updateArticleHandler);
// Building (create/edit a draft) is every role's; publishing and archiving —
// "putting things in front of players" / taking them away — are Team Lead +
// Admin only, same split formsRouter.ts already enforces for forms.
articlesRouter.post('/articles/:id/publish', requireTeamLeadOrAdmin, publishArticleHandler);
articlesRouter.post('/articles/:id/archive', requireTeamLeadOrAdmin, archiveArticleHandler);
articlesRouter.post('/articles/:id/attachments', finalizeArticleAttachmentHandler);
articlesRouter.post('/articles/generate-keywords', generateKeywordsHandler);
