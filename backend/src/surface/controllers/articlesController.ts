import type { RequestHandler } from 'express';
import { PublicArticleListQuery } from '@support/types';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import { getPublicArticle, listPublicArticles } from '../services/articlesService.ts';

const ArticleIdParams = z.object({ id: z.uuid() });

export const listPublicArticlesHandler: RequestHandler = async (req, res) => {
  const query = PublicArticleListQuery.safeParse(req.query);
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'Invalid query parameters.');
    return;
  }
  res.status(200).json(await listPublicArticles(req.player!, query.data));
};

export const getPublicArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const found = await getPublicArticle(req.player!, params.data.id);
  if (!found) {
    sendError(res, 404, 'not_found', 'Article not found.');
    return;
  }
  res.status(200).json(found);
};
