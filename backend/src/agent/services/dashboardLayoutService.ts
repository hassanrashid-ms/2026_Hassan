import { and, eq } from 'drizzle-orm'
import type { DashboardLayout } from '@support/types'
import { agentDashboardLayout } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'

// x/w are in a 12-column grid; each row is 1 unit tall in react-grid-layout terms.
export const DEFAULT_LAYOUT: DashboardLayout = {
  items: [
    { i: 'volume-series', x: 0, y: 0, w: 6, h: 2 },
    { i: 'status-breakdown', x: 6, y: 0, w: 3, h: 2 },
    { i: 'open-total', x: 9, y: 0, w: 3, h: 1 },
    { i: 'volume-by-priority', x: 9, y: 1, w: 3, h: 1 },
    { i: 'first-response-time', x: 0, y: 2, w: 3, h: 1 },
    { i: 'resolution-time', x: 3, y: 2, w: 3, h: 1 },
    { i: 'time-to-claim', x: 6, y: 2, w: 6, h: 1 },
    { i: 'bot-containment', x: 0, y: 3, w: 3, h: 1 },
    { i: 'self-serve-rate', x: 3, y: 3, w: 3, h: 1 },
    { i: 'handoff-reasons', x: 6, y: 3, w: 3, h: 2 },
    { i: 'article-hit-rate', x: 0, y: 4, w: 3, h: 1 },
    { i: 'avg-open-per-agent', x: 9, y: 3, w: 3, h: 1 },
    { i: 'unassigned-queue-depth', x: 3, y: 4, w: 3, h: 2 },
  ],
  visibleTileIds: [
    'volume-series',
    'status-breakdown',
    'open-total',
    'volume-by-priority',
    'first-response-time',
    'resolution-time',
    'time-to-claim',
    'bot-containment',
    'self-serve-rate',
    'handoff-reasons',
    'article-hit-rate',
    'avg-open-per-agent',
    'unassigned-queue-depth',
  ],
}

export async function getDashboardLayout(ctx: AgentContext): Promise<DashboardLayout> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .select({ layout: agentDashboardLayout.layout })
      .from(agentDashboardLayout)
      .where(and(eq(agentDashboardLayout.agentId, ctx.agentId), eq(agentDashboardLayout.workspaceId, ctx.workspaceId)))
    return row?.layout ?? DEFAULT_LAYOUT
  })
}

export async function saveDashboardLayout(ctx: AgentContext, layout: DashboardLayout): Promise<void> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    await tx
      .insert(agentDashboardLayout)
      .values({ agentId: ctx.agentId, workspaceId: ctx.workspaceId, layout })
      .onConflictDoUpdate({
        target: [agentDashboardLayout.agentId, agentDashboardLayout.workspaceId],
        set: { layout, updatedAt: new Date() },
      })
  })
}
