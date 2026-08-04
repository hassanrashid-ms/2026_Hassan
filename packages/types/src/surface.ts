import { z } from 'zod'

/**
 * NOT part of the frozen contract. The web surface ships with the server, so these
 * shapes may change freely — unlike anything in sdk-wire.ts.
 */
export const BootstrapQuery = z.object({ session_id: z.uuid() })

export const ArticleReadBody = z.object({
  session_id: z.uuid(),
  article_id: z.string().min(1).max(200),
})

export type PlayerStateAvailability = 'ok' | 'degraded' | 'missing' | 'absent'

export type BootstrapResponse = {
  session: { id: string; entry_point: string; started_at: string; ended_at: string | null }
  player: { external_player_id: string }
  player_state: {
    availability: PlayerStateAvailability
    captured_at: string | null
    degraded_reason: string | null
    declared: Record<string, unknown>
    raw?: Record<string, unknown>
  }
  unread_count: number
}
