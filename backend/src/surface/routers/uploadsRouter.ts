import { Router } from 'express';
import { deleteUploadHandler, postUploadRequestHandler } from '../controllers/uploadsController.ts';

export const uploadsRouter = Router();
uploadsRouter.post('/uploads', postUploadRequestHandler);
// :key contains slashes (pending/{ws}/{player}/{uuid}.ext) — Express 5 needs the
// wildcard form to capture the rest of the path in one param.
uploadsRouter.delete(
  '/uploads/{*key}',
  (req, res, next) => {
    const raw = req.params.key;
    req.params.key = Array.isArray(raw) ? raw.join('/') : (raw ?? '');
    next();
  },
  deleteUploadHandler,
);
