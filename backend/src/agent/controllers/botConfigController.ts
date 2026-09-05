import type { RequestHandler } from 'express';
import {
  BotConfigVersionsQuery,
  RollbackBotConfigVersionBody,
  SaveBotConfigBody,
} from '@support/types';
import { sendError } from '../../errors.ts';
import {
  EmptyBotPrompt,
  InvalidRulesPayload,
  InvalidToolsPayload,
  InvalidLimitsPayload,
} from '../../domain/bot/botConfig.ts';
import {
  BotConfigVersionNotFound,
  getBotConfigVersionForAgent,
  getBotConfigView,
  listBotConfigVersionsForAgent,
  rollbackBotConfigVersionForAgent,
  saveBotConfigForAgent,
} from '../services/botConfigService.ts';

export const getBotConfigHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await getBotConfigView(req.agent!));
};

export const saveBotConfigHandler: RequestHandler = async (req, res) => {
  const body = SaveBotConfigBody.safeParse(req.body);
  if (!body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'At least one of is_provisioned, prompt, rules, tools_config or limits_config is required.',
    );
    return;
  }

  try {
    res.status(200).json(
      await saveBotConfigForAgent(req.agent!, {
        isProvisioned: body.data.is_provisioned,
        prompt: body.data.prompt,
        rules: body.data.rules,
        toolsConfig: body.data.tools_config,
        limitsConfig: body.data.limits_config,
      }),
    );
  } catch (error) {
    if (
      error instanceof EmptyBotPrompt ||
      error instanceof InvalidRulesPayload ||
      error instanceof InvalidToolsPayload ||
      error instanceof InvalidLimitsPayload
    ) {
      sendError(res, 422, 'invalid_request', error.message);
      return;
    }
    throw error;
  }
};

export const getBotConfigVersionsHandler: RequestHandler = async (req, res) => {
  const query = BotConfigVersionsQuery.safeParse(req.query);
  if (!query.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'limit must be 1-200, cursor must be a positive integer.',
    );
    return;
  }
  res.status(200).json(
    await listBotConfigVersionsForAgent(req.agent!, {
      limit: query.data.limit,
      cursor: query.data.cursor,
    }),
  );
};

export const getBotConfigVersionHandler: RequestHandler = async (req, res) => {
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version < 1) {
    sendError(res, 422, 'invalid_request', 'version must be a positive integer.');
    return;
  }
  try {
    res.status(200).json(await getBotConfigVersionForAgent(req.agent!, version));
  } catch (error) {
    if (error instanceof BotConfigVersionNotFound) {
      sendError(res, 404, 'not_found', error.message);
      return;
    }
    throw error;
  }
};

export const rollbackBotConfigHandler: RequestHandler = async (req, res) => {
  const body = RollbackBotConfigVersionBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'version is required and must be a positive integer.');
    return;
  }
  try {
    res.status(200).json(await rollbackBotConfigVersionForAgent(req.agent!, body.data.version));
  } catch (error) {
    if (error instanceof BotConfigVersionNotFound) {
      sendError(res, 404, 'not_found', error.message);
      return;
    }
    if (
      error instanceof InvalidRulesPayload ||
      error instanceof InvalidToolsPayload ||
      error instanceof InvalidLimitsPayload ||
      error instanceof EmptyBotPrompt
    ) {
      sendError(res, 422, 'invalid_request', error.message);
      return;
    }
    throw error;
  }
};
