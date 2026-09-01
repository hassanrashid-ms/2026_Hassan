import { and, eq } from 'drizzle-orm'
import type { DashboardLayout, DashboardLayoutItem } from '@support/types'
import { agentDashboardLayout } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'

// x/w are in a 12-column grid; each row is 1 unit tall in react-grid-layout terms.
// minW/minH are set to each tile's own shipped w/h — every tile's content was
// built to fit at that size, so a floor at the default size is what stops a
// resize from clipping/overflowing a title or a chart's legend.
function tile(i: string, x: number, y: number, w: number, h: number) {
  return { i, x, y, w, h, minW: w, minH: h }
}

export const DEFAULT_LAYOUT: DashboardLayout = {
  items: [
    tile('volume-series', 0, 0, 6, 2),
    tile('status-breakdown', 6, 0, 3, 2),
    tile('open-total', 9, 0, 3, 1),
    tile('volume-by-priority', 9, 1, 3, 1),
    tile('first-response-time', 0, 2, 3, 1),
    tile('resolution-time', 3, 2, 3, 1),
    tile('time-to-claim', 6, 2, 6, 1),
    tile('bot-containment', 0, 3, 3, 1),
    tile('self-serve-rate', 3, 3, 3, 1),
    tile('handoff-reasons', 6, 3, 3, 2),
    tile('article-hit-rate', 0, 4, 3, 1),
    tile('avg-open-per-agent', 9, 3, 3, 1),
    tile('unassigned-queue-depth', 3, 4, 3, 2),
    tile('top-cited-articles', 6, 4, 3, 2),
    tile('top-read-articles', 9, 4, 3, 2),
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
    'top-cited-articles',
    'top-read-articles',
  ],
}

const DEFAULT_ITEM_BY_ID = new Map(DEFAULT_LAYOUT.items.map((item) => [item.i, item]))

// A layout saved before minW/minH existed (or before a tile's size floor
// changed) can be sitting below the current floor — clamp it back up and
// attach the floor, so an already-too-small tile self-heals on the next read
// instead of requiring the agent to notice and resize it themselves.
function withSizeFloor(item: DashboardLayoutItem): DashboardLayoutItem {
  const def = DEFAULT_ITEM_BY_ID.get(item.i)
  if (!def) return item
  return { ...item, w: Math.max(item.w, def.minW!), h: Math.max(item.h, def.minH!), minW: def.minW, minH: def.minH }
}

// Once an agent's grid is touched at all (drag/resize), the client autosaves
// the whole snapshot — a saved row is then returned as-is forever, and any
// tile id added to DEFAULT_LAYOUT after that point would never reach that
// agent. Merge new default tiles into a saved layout on every read so newly
// shipped tiles show up without requiring anyone to manually re-edit a layout.
function mergeNewDefaultTiles(saved: DashboardLayout): DashboardLayout {
  const savedIds = new Set(saved.items.map((item) => item.i))
  const newItems = DEFAULT_LAYOUT.items.filter((item) => !savedIds.has(item.i))
  return {
    items: [...saved.items.map(withSizeFloor), ...newItems],
    visibleTileIds: newItems.length === 0 ? saved.visibleTileIds : [...saved.visibleTileIds, ...newItems.map((item) => item.i)],
  }
}

export async function getDashboardLayout(ctx: AgentContext): Promise<DashboardLayout> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .select({ layout: agentDashboardLayout.layout })
      .from(agentDashboardLayout)
      .where(and(eq(agentDashboardLayout.agentId, ctx.agentId), eq(agentDashboardLayout.workspaceId, ctx.workspaceId)))
    if (!row?.layout) return DEFAULT_LAYOUT
    return mergeNewDefaultTiles(row.layout)
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
