import { Router } from 'express';
import { getPresenceHandler, setPresenceHandler } from '../controllers/presenceController.ts';

export const presenceRouter = Router();
presenceRouter.get('/presence', getPresenceHandler);
presenceRouter.patch('/presence', setPresenceHandler);
