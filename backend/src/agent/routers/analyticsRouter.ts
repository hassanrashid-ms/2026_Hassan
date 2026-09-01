import { Router } from 'express'
import { getDashboardLayoutHandler, saveDashboardLayoutHandler } from '../controllers/analyticsController.ts'

export const analyticsRouter = Router()
analyticsRouter.get('/analytics/layout', getDashboardLayoutHandler)
analyticsRouter.put('/analytics/layout', saveDashboardLayoutHandler)
