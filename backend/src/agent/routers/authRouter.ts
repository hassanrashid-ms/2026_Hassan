import { Router } from 'express';
import { devAgents, devLogin } from '../controllers/authController.ts';

export const authRouter = Router();
authRouter.get('/auth/dev-agents', devAgents);
authRouter.post('/auth/dev-login', devLogin);
