import { Router } from 'express'
import {
  archiveTagHandler,
  attachTagHandler,
  createTagHandler,
  detachTagHandler,
  listTagsHandler,
  renameTagHandler,
} from '../controllers/tagsController.ts'

export const tagsRouter = Router()
tagsRouter.get('/tags', listTagsHandler)
tagsRouter.post('/tags', createTagHandler)
tagsRouter.patch('/tags/:id', renameTagHandler)
tagsRouter.post('/tags/:id/archive', archiveTagHandler)
tagsRouter.post('/conversations/:id/tags', attachTagHandler)
tagsRouter.delete('/conversations/:id/tags/:tagId', detachTagHandler)
