import { Router } from 'express';
import {
  getAnalyticsHandler,
  getDashboardLayoutHandler,
  saveDashboardLayoutHandler,
} from '../controllers/analyticsController.ts';

export const analyticsRouter = Router();
analyticsRouter.get('/analytics', getAnalyticsHandler);
analyticsRouter.get('/analytics/layout', getDashboardLayoutHandler);
analyticsRouter.put('/analytics/layout', saveDashboardLayoutHandler);
