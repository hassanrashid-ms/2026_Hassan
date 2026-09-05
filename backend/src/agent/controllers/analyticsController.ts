import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import { getDashboardLayout, saveDashboardLayout } from '../services/dashboardLayoutService.ts';
import {
  getBotMetrics,
  getSpeedMetrics,
  getTeamMetrics,
  getTopArticles,
  getVolumeMetrics,
} from '../services/analyticsService.ts';

const DashboardLayoutItemSchema = z.object({
  i: z.string().min(1),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  minW: z.number().int().positive().optional(),
  minH: z.number().int().positive().optional(),
});

const SaveLayoutBody = z.object({
  layout: z.object({
    items: z.array(DashboardLayoutItemSchema),
    visibleTileIds: z.array(z.string()),
  }),
});

export const getDashboardLayoutHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const layout = await getDashboardLayout(ctx);
  res.status(200).json({ layout });
};

export const saveDashboardLayoutHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const body = SaveLayoutBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'layout must have items[] and visibleTileIds[].');
    return;
  }
  await saveDashboardLayout(ctx, body.data.layout);
  res.status(200).json({ ok: true });
};

const AnalyticsQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  granularity: z.enum(['day', 'week']).default('day'),
});

export const getAnalyticsHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const query = AnalyticsQuery.safeParse(req.query);
  if (!query.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'from/to must be YYYY-MM-DD and granularity must be day or week.',
    );
    return;
  }
  const range = query.data;
  const [volume, speed, bot, team, articles] = await Promise.all([
    getVolumeMetrics(ctx, range),
    getSpeedMetrics(ctx, range),
    getBotMetrics(ctx, range),
    getTeamMetrics(ctx, range),
    getTopArticles(ctx, range),
  ]);
  res.status(200).json({ range, volume, speed, bot, team, articles });
};
