import type { RequestHandler } from 'express';
import { sendError } from '../../errors.ts';
import { TestBotTurnBody } from '@support/types';
import { runTestBotTurn } from '../../domain/bot/botTestTurn.ts';

export const testBotTurnHandler: RequestHandler = async (req, res) => {
  const body = TestBotTurnBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'Invalid test-turn payload.');
    return;
  }

  const decision = await runTestBotTurn(req.agent!, body.data);
  res.status(200).json({ decision });
};
