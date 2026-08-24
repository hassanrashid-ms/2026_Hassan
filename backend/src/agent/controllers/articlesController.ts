import type { RequestHandler } from 'express'
import { z } from 'zod'
import { CreateArticleBody, UpdateArticleBody } from '@support/types'
import { sendError } from '../../errors.ts'
import {
  archiveArticle,
  createArticle,
  getArticle,
  listArticles,
  publishArticle,
  updateArticle,
  generateKeywords,
} from '../services/articlesService.ts'
import { GenerateKeywordsBody } from '@support/types'

const ArticleIdParams = z.object({ id: z.uuid() })

export const listArticlesHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await listArticles(req.agent!))
}

export const getArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const found = await getArticle(req.agent!, params.data.id)
  if (!found) {
    sendError(res, 404, 'not_found', 'Article not found.')
    return
  }
  res.status(200).json(found)
}

export const createArticleHandler: RequestHandler = async (req, res) => {
  const body = CreateArticleBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'title and body are required.')
    return
  }
  const result = await createArticle(req.agent!, {
    title: body.data.title,
    body: body.data.body,
    keywords: body.data.keywords,
    intentId: body.data.intent_id,
  })
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Intent not found.')
    return
  }
  res.status(201).json(result.article)
}

export const updateArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params)
  const body = UpdateArticleBody.safeParse(req.body)
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'Invalid article update payload.')
    return
  }
  const result = await updateArticle(req.agent!, params.data.id, {
    title: body.data.title,
    body: body.data.body,
    keywords: body.data.keywords,
    intentId: body.data.intent_id,
  })
  if (!result.ok) {
    if (result.reason === 'not_found' || result.reason === 'intent_not_found') {
      sendError(res, 404, 'not_found', 'Article or intent not found.')
      return
    }
    sendError(res, 409, 'invalid_request', 'Article is not a draft.')
    return
  }
  res.status(200).json(result.article)
}

export const publishArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const result = await publishArticle(req.agent!, params.data.id)
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Article not found.')
      return
    }
    const message = result.reason === 'empty_fields' ? 'Title and body must be non-empty to publish.' : 'Article is not a draft.'
    sendError(res, 409, 'invalid_request', message)
    return
  }
  res.status(200).json(result.article)
}

export const archiveArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const result = await archiveArticle(req.agent!, params.data.id)
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Article not found.')
    return
  }
  res.status(200).json(result.article)
}

export const generateKeywordsHandler: RequestHandler = async (req, res) => {
  const body = GenerateKeywordsBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'title and body are required.')
    return
  }
  
  try {
    const keywords = await generateKeywords(body.data.title, body.data.body)
    res.status(200).json({ keywords })
  } catch (error) {
    sendError(res, 500, 'internal', 'Failed to generate keywords.')
  }
}
