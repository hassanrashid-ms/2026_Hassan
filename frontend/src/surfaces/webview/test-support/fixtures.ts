import type { BootstrapResponse } from '@support/types';

/**
 * A fully-populated BootstrapResponse for tests that need `data` to be non-null.
 * Built against the real type so a future field addition fails these tests
 * instead of silently under-specifying the fixture.
 */
export function makeBootstrapResponse(
  overrides: Partial<BootstrapResponse> = {},
): BootstrapResponse {
  return {
    workspace: { name: 'Neon Drift' },
    session: {
      id: 'session-1',
      entry_point: 'test',
      started_at: '2026-08-10T00:00:00.000Z',
      ended_at: null,
    },
    player: { external_player_id: 'player-1' },
    player_state: {
      availability: 'ok',
      captured_at: '2026-08-10T00:00:00.000Z',
      degraded_reason: null,
      declared: {},
    },
    unread_count: 0,
    ...overrides,
  };
}
