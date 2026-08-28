import type { RequestHandler } from 'express';
import { z } from 'zod';
import {
  ArticleVersionsQuery,
  CreateArticleBody,
  FinalizeArticleAttachmentBody,
  SaveArticleDraftBody,
  UpdateArticleBody,
} from '@support/types';
import { sendError } from '../../errors.ts';
import { deleteObject } from '../../shared/storage/presign.ts';
import {
  archiveArticle,
  createArticle,
  discardArticleDraft,
  finalizeArticleAttachment,
  getArticle,
  getArticleVersion,
  listArticles,
  listArticleVersions,
  publishArticle,
  removeArticleAttachment,
  restoreArticleVersion,
  saveArticleDraft,
  unarchiveArticle,
  updateArticle,
  generateKeywords,
} from '../services/articlesService.ts';
import { GenerateKeywordsBody } from '@support/types';

const ArticleIdParams = z.object({ id: z.uuid() });
const ArticleAttachmentParams = z.object({ id: z.uuid(), attachmentId: z.uuid() });
const ArticleVersionParams = z.object({ id: z.uuid(), version: z.coerce.number().int().positive() });

export const listArticlesHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await listArticles(req.agent!));
};

export const getArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const found = await getArticle(req.agent!, params.data.id);
  if (!found) {
    sendError(res, 404, 'not_found', 'Article not found.');
    return;
  }
  res.status(200).json(found);
};

export const createArticleHandler: RequestHandler = async (req, res) => {
  const body = CreateArticleBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'title and body are required.');
    return;
  }
  const result = await createArticle(req.agent!, {
    title: body.data.title,
    body: body.data.body,
    keywords: body.data.keywords,
    intentId: body.data.intent_id,
  });
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Intent not found.');
    return;
  }
  res.status(201).json(result.article);
};

export const updateArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  const body = UpdateArticleBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'Invalid article update payload.');
    return;
  }
  const result = await updateArticle(req.agent!, params.data.id, {
    title: body.data.title,
    body: body.data.body,
    keywords: body.data.keywords,
    intentId: body.data.intent_id,
  });
  if (!result.ok) {
    if (result.reason === 'not_found' || result.reason === 'intent_not_found') {
      sendError(res, 404, 'not_found', 'Article or intent not found.');
      return;
    }
    sendError(res, 409, 'invalid_request', 'Article is not a draft.');
    return;
  }
  res.status(200).json(result.article);
};

export const saveArticleDraftHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  const body = SaveArticleDraftBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'Invalid draft payload.');
    return;
  }
  const result = await saveArticleDraft(req.agent!, params.data.id, {
    title: body.data.title,
    body: body.data.body,
    keywords: body.data.keywords,
  });
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Article not found.');
      return;
    }
    sendError(res, 409, 'invalid_request', 'Article is not published.');
    return;
  }
  res.status(200).json(result.article);
};

export const discardArticleDraftHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const result = await discardArticleDraft(req.agent!, params.data.id);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Article not found.');
      return;
    }
    sendError(res, 409, 'invalid_request', 'No draft to discard.');
    return;
  }
  res.status(200).json(result.article);
};

export const listArticleVersionsHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  const query = ArticleVersionsQuery.safeParse(req.query);
  if (!params.success || !query.success) {
    sendError(res, 422, 'invalid_request', 'Invalid query.');
    return;
  }
  const result = await listArticleVersions(req.agent!, params.data.id, query.data);
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Article not found.');
    return;
  }
  res.status(200).json(result.versions);
};

export const getArticleVersionHandler: RequestHandler = async (req, res) => {
  const params = ArticleVersionParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'Invalid version.');
    return;
  }
  const result = await getArticleVersion(req.agent!, params.data.id, params.data.version);
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Version not found.');
    return;
  }
  res.status(200).json(result.version);
};

export const restoreArticleVersionHandler: RequestHandler = async (req, res) => {
  const params = ArticleVersionParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'Invalid version.');
    return;
  }
  const result = await restoreArticleVersion(req.agent!, params.data.id, params.data.version);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Article or version not found.');
      return;
    }
    sendError(res, 409, 'invalid_request', 'Article is not published.');
    return;
  }
  res.status(200).json(result.article);
};

export const removeArticleAttachmentHandler: RequestHandler = async (req, res) => {
  const params = ArticleAttachmentParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'Invalid ids.');
    return;
  }
  const result = await removeArticleAttachment(req.agent!, params.data.id, params.data.attachmentId);
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Article or attachment not found.');
    return;
  }
  res.status(200).json(result.article);
};

export const publishArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const result = await publishArticle(req.agent!, params.data.id);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Article not found.');
      return;
    }
    const message =
      result.reason === 'empty_fields'
        ? 'Title and body must be non-empty to publish.'
        : 'Article is not a draft.';
    sendError(res, 409, 'invalid_request', message);
    return;
  }
  res.status(200).json(result.article);
};

export const archiveArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const result = await archiveArticle(req.agent!, params.data.id);
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Article not found.');
    return;
  }
  res.status(200).json(result.article);
};

export const unarchiveArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const result = await unarchiveArticle(req.agent!, params.data.id);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Article not found.');
      return;
    }
    sendError(res, 409, 'invalid_request', 'Article is not archived.');
    return;
  }
  res.status(200).json(result.article);
};

export const finalizeArticleAttachmentHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  const body = FinalizeArticleAttachmentBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'key, filename, mime_type and byte_size are required.');
    return;
  }
  const result = await finalizeArticleAttachment(req.agent!, params.data.id, body.data);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Article not found.');
      return;
    }
    if (result.reason === 'not_draft') {
      sendError(res, 409, 'invalid_request', 'Article is not a draft.');
      return;
    }
    if (result.reason === 'attachment_not_found') {
      sendError(
        res,
        422,
        'attachment_not_found',
        'The uploaded file was not found or has expired.',
      );
      return;
    }
    sendError(
      res,
      422,
      'attachment_mismatch',
      'The uploaded file does not match its declared type or size.',
    );
    return;
  }
  // Best-effort, after the transaction committed — same reasoning as sendAgentMessage:
  // a transient storage error here must never surface as a failed finalize to the
  // agent once the row already exists.
  try {
    await deleteObject(result.pendingKey);
  } catch {
    // Logged inside deleteObject's callers elsewhere; safe to ignore here too —
    // an orphaned pending object is cheap and harmless.
  }
  res.status(200).json(result.attachment);
};

export const generateKeywordsHandler: RequestHandler = async (req, res) => {
  const body = GenerateKeywordsBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'title and body are required.');
    return;
  }

  try {
    const keywords = await generateKeywords(body.data.title, body.data.body);
    res.status(200).json({ keywords });
  } catch (error) {
    sendError(res, 500, 'internal', 'Failed to generate keywords.');
  }
};
