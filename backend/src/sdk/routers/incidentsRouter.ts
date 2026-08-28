import { Router } from 'express';
import { incidents } from '../controllers/incidentsController.ts';

export const incidentsRouter = Router();
incidentsRouter.post('/incidents', incidents);
