import type { RequestHandler } from 'express';
import {
  BootstrapQuery,
  type BootstrapResponse,
  type PlayerStateAvailability,
} from '@support/types';
import { getEnv } from '../../env.ts';
import { sendError } from '../../errors.ts';
import { loadBootstrap } from '../services/bootstrapService.ts';

export const bootstrap: RequestHandler = async (req, res) => {
  const ctx = req.player!;

  const query = BootstrapQuery.safeParse(req.query);
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid.');
    return;
  }

  const result = await loadBootstrap(ctx, query.data);

  if (!result) {
    sendError(res, 404, 'not_found', 'Session not found.');
    return;
  }

  const { found, snapshot, unreadCount, workspaceName } = result;

  // Three distinct no-data states, all rendered "unavailable" but diagnosed
  // differently. All three are states, never errors.
  const availability: PlayerStateAvailability = !snapshot
    ? 'absent'
    : snapshot.isMissing
      ? 'missing'
      : snapshot.degradedReason
        ? 'degraded'
        : 'ok';

  const payload: BootstrapResponse = {
    workspace: { name: workspaceName },
    session: {
      id: found.id,
      entry_point: found.entryPoint,
      started_at: found.startedAt.toISOString(),
      ended_at: found.endedAt?.toISOString() ?? null,
    },
    player: { external_player_id: found.externalPlayerId },
    player_state: {
      availability,
      captured_at: snapshot?.capturedAt.toISOString() ?? null,
      degraded_reason: snapshot?.degradedReason ?? null,
      declared: snapshot?.declared ?? {},
      // `raw` is the player's own data, but it is also PII by default and the real
      // surface has no use for it — the agent Game View is what reads it. It is
      // exposed outside production only, because proving the split is the whole
      // point of the stub. Remove this branch when the real chat UI lands.
      ...(getEnv().NODE_ENV === 'production' ? {} : { raw: snapshot?.raw ?? {} }),
    },
    unread_count: unreadCount,
  };

  res.status(200).json(payload);
};
