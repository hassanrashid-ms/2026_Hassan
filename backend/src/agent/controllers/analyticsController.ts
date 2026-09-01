import type { RequestHandler } from 'express'
import { z } from 'zod'
import { sendError } from '../../errors.ts'
import { getDashboardLayout, saveDashboardLayout } from '../services/dashboardLayoutService.ts'

const DashboardLayoutItemSchema = z.object({
  i: z.string().min(1),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
})

const SaveLayoutBody = z.object({
  layout: z.object({
    items: z.array(DashboardLayoutItemSchema),
    visibleTileIds: z.array(z.string()),
  }),
})

export const getDashboardLayoutHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const layout = await getDashboardLayout(ctx)
  res.status(200).json({ layout })
}

export const saveDashboardLayoutHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const body = SaveLayoutBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'layout must have items[] and visibleTileIds[].')
    return
  }
  await saveDashboardLayout(ctx, body.data.layout)
  res.status(200).json({ ok: true })
}
