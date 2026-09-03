import type { RequestHandler } from 'express';
import { sendError } from '../../errors.ts';
import { TestResolutionAnswerBody } from '@support/types';
import { runTestResolutionAnswer } from '../../domain/bot/botTestResolution.ts';
import { logger } from '../../shared/logging/logger.ts';

export const testResolutionAnswerHandler: RequestHandler = async (req, res) => {
  const body = TestResolutionAnswerBody.safeParse(req.body);
  if (!body.success) {
    logger.warn('bot.testResolution', 'invalid test-resolution payload', {
      workspaceId: req.agent?.workspaceId,
      issues: body.error.issues,
    });
    sendError(res, 422, 'invalid_request', 'Invalid test-resolution payload.');
    return;
  }

  const decision = await runTestResolutionAnswer(req.agent!, body.data);
  res.status(200).json({ decision });
};
