import type { RequestHandler } from 'express';
import { sendError } from '../../errors.ts';
import { TestBotTurnBody } from '@support/types';
import { runTestBotTurn } from '../../domain/bot/botTestTurn.ts';
import { logger } from '../../shared/logging/logger.ts';

export const testBotTurnHandler: RequestHandler = async (req, res) => {
  const body = TestBotTurnBody.safeParse(req.body);
  if (!body.success) {
    logger.warn('bot.testTurn', 'invalid test-turn payload', {
      workspaceId: req.agent?.workspaceId,
      issues: body.error.issues,
    });
    sendError(res, 422, 'invalid_request', 'Invalid test-turn payload.');
    return;
  }

  const decision = await runTestBotTurn(req.agent!, body.data);
  res.status(200).json({ decision });
};
