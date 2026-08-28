import { Router } from 'express';
import {
  formAnswerHandler,
  formSkipHandler,
  formSubmitHandler,
} from '../controllers/formController.ts';

export const formRouter = Router();
formRouter.post('/form/answer', formAnswerHandler);
formRouter.post('/form/submit', formSubmitHandler);
formRouter.post('/form/skip', formSkipHandler);
