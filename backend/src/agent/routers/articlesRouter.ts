import { Router } from 'express';
import { requireTeamLeadOrAdmin } from '../../shared/middleware/requireTeamLeadOrAdmin.ts';
import {
  archiveArticleHandler,
  bulkExportArticlesHandler,
  bulkImportArticlesHandler,
  createArticleHandler,
  discardArticleDraftHandler,
  finalizeArticleAttachmentHandler,
  getArticleHandler,
  getArticleVersionHandler,
  listArticlesHandler,
  listArticleVersionsHandler,
  publishArticleHandler,
  removeArticleAttachmentHandler,
  restoreArticleVersionHandler,
  saveArticleDraftHandler,
  unarchiveArticleHandler,
  updateArticleHandler,
  generateKeywordsHandler,
} from '../controllers/articlesController.ts';

export const articlesRouter = Router();
articlesRouter.get('/articles', listArticlesHandler);
articlesRouter.get('/articles/:id', getArticleHandler);
articlesRouter.post('/articles', createArticleHandler);
articlesRouter.patch('/articles/:id', updateArticleHandler);
articlesRouter.patch('/articles/:id/draft', saveArticleDraftHandler);
articlesRouter.delete('/articles/:id/draft', discardArticleDraftHandler);
articlesRouter.get('/articles/:id/versions', listArticleVersionsHandler);
articlesRouter.get('/articles/:id/versions/:version', getArticleVersionHandler);
articlesRouter.post('/articles/:id/versions/:version/restore', restoreArticleVersionHandler);
articlesRouter.delete('/articles/:id/attachments/:attachmentId', removeArticleAttachmentHandler);
// Building (create/edit a draft) is every role's; publishing and archiving —
// "putting things in front of players" / taking them away — are Team Lead +
// Admin only, same split formsRouter.ts already enforces for forms.
articlesRouter.post('/articles/:id/publish', requireTeamLeadOrAdmin, publishArticleHandler);
articlesRouter.post('/articles/:id/archive', requireTeamLeadOrAdmin, archiveArticleHandler);
articlesRouter.post('/articles/:id/unarchive', requireTeamLeadOrAdmin, unarchiveArticleHandler);
articlesRouter.post('/articles/bulk-import', requireTeamLeadOrAdmin, bulkImportArticlesHandler);
articlesRouter.post('/articles/bulk-export', requireTeamLeadOrAdmin, bulkExportArticlesHandler);
articlesRouter.post('/articles/:id/attachments', finalizeArticleAttachmentHandler);
articlesRouter.post('/articles/generate-keywords', generateKeywordsHandler);
