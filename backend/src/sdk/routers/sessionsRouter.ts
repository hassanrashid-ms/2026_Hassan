import { Router } from 'express';
import { sessionsEnd, sessionsStart } from '../controllers/sessionsController.ts';

export const sessionsRouter = Router();
sessionsRouter.post('/sessions/start', sessionsStart);
sessionsRouter.post('/sessions/end', sessionsEnd);
