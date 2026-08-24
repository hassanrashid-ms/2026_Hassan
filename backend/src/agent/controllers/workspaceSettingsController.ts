import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import { getWorkspaceSettings, saveWorkspaceSettings } from '../services/workspaceSettingsService.ts';

export const getWorkspaceSettingsHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await getWorkspaceSettings(req.agent!));
};

const SaveWorkspaceSettingsBody = z.object({
  max_assigned_tickets: z.number().int().min(1).max(100),
  auto_close_days: z.number().int().min(1).max(365),
  inactivity_window_hours: z.number().int().min(1).max(720),
  form_timeout_minutes: z.number().int().min(1).max(1440),
});

export const saveWorkspaceSettingsHandler: RequestHandler = async (req, res) => {
  const body = SaveWorkspaceSettingsBody.safeParse(req.body);
  if (!body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'max_assigned_tickets, auto_close_days, inactivity_window_hours and form_timeout_minutes are required and must be within bounds.',
    );
    return;
  }

  res.status(200).json(
    await saveWorkspaceSettings(req.agent!, {
      maxAssignedTickets: body.data.max_assigned_tickets,
      autoCloseDays: body.data.auto_close_days,
      inactivityWindowHours: body.data.inactivity_window_hours,
      formTimeoutMinutes: body.data.form_timeout_minutes,
    }),
  );
};
