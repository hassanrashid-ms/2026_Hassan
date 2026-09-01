import type { ReactNode } from 'react'
import type { AnalyticsResponse } from '@support/types'
import { NumberTile } from './tiles/NumberTile.tsx'
import { LineChartTile } from './tiles/LineChartTile.tsx'
import { DonutChartTile } from './tiles/DonutChartTile.tsx'
import { BarChartTile } from './tiles/BarChartTile.tsx'
import { RankedListTile } from './tiles/RankedListTile.tsx'

// Keep in sync by hand with DEFAULT_LAYOUT.visibleTileIds in
// backend/src/agent/services/dashboardLayoutService.ts — the backend has no
// runtime dependency on this file (frontend/backend only share @support/types).
export const TILE_IDS = [
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
] as const

export function renderTile(id: string, data: AnalyticsResponse): ReactNode {
  switch (id) {
    case 'volume-series':
      return <LineChartTile title="New vs. resolved" series={data.volume.series} dataKeys={['opened', 'resolved']} />
    case 'status-breakdown':
      return (
        <DonutChartTile title="Status breakdown" data={data.volume.byStatus.map((s) => ({ label: s.status, value: s.count }))} />
      )
    case 'open-total':
      return <NumberTile title="Open tickets" value={data.volume.openTotal} />
    case 'volume-by-priority':
      return (
        <BarChartTile title="Volume by priority" data={data.volume.byPriority.map((p) => ({ label: p.priority, value: p.count }))} />
      )
    case 'first-response-time':
      return <NumberTile title="First response (avg)" value={data.speed.firstResponse.avgSeconds} format="duration" />
    case 'resolution-time':
      return <NumberTile title="Resolution time (avg)" value={data.speed.resolution.avgSeconds} format="duration" />
    case 'time-to-claim':
      return (
        <LineChartTile
          title="Time to claim"
          series={data.speed.timeToClaim.series.map((p) => ({ bucket: p.bucket, seconds: p.seconds ?? 0 }))}
          dataKeys={['seconds']}
        />
      )
    case 'bot-containment':
      return <NumberTile title="Bot containment" value={data.bot.containmentRate} format="percent" />
    case 'self-serve-rate':
      return <NumberTile title="Self-serve rate" value={data.bot.selfServeRate} format="percent" />
    case 'handoff-reasons':
      return (
        <DonutChartTile title="Handoff reasons" data={data.bot.handoff.byReason.map((r) => ({ label: r.reason, value: r.count }))} />
      )
    case 'article-hit-rate':
      return <NumberTile title="Article hit rate" value={data.bot.articleHitRate} format="percent" />
    case 'avg-open-per-agent':
      return <NumberTile title="Avg open per agent" value={data.team.avgOpenPerActiveAgent} />
    case 'unassigned-queue-depth':
      return (
        <LineChartTile
          title="Unassigned queue depth"
          series={data.team.unassignedQueueDepth.series.map((p) => ({ bucket: p.bucket, depth: p.depth }))}
          dataKeys={['depth']}
        />
      )
    case 'top-cited-articles':
      return (
        <RankedListTile
          title="Top cited by bot"
          items={data.articles.topCited.map((a) => ({ id: a.articleId, label: a.title, count: a.count }))}
        />
      )
    case 'top-read-articles':
      return (
        <RankedListTile
          title="Top read by players"
          items={data.articles.topRead.map((a) => ({ id: a.articleId, label: a.title, count: a.count }))}
        />
      )
    default:
      return null
  }
}
