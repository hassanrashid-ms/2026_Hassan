import { Router } from 'express';
import { getMembershipsHandler } from '../controllers/membershipsController.ts';

export const membershipsRouter = Router();
membershipsRouter.get('/memberships', getMembershipsHandler);
