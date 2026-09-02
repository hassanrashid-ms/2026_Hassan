import type { Server } from 'socket.io';
import { toAgentView, toPlayerView } from '../conversations/serializers.ts';
import {
  emitInboxChanged,
  emitMessageToRooms,
  emitNotificationNew,
  emitPhaseChanged,
} from '../../shared/realtime/emit.ts';
import { getIo } from '../../shared/realtime/socketServer.ts';
import { logger } from '../../shared/logging/logger.ts';
import type { CompleteFormResult } from './completeFormAndHandoff.ts';

/**
 * One emit shape for the same three callers completeFormAndHandoff has, so the
 * two halves cannot drift: whatever the transaction did, this announces.
 *
 * The socket server may not be running at all — the sweeper is exercised
 * directly in tests with no Redis, the same contract the bot orchestrator's
 * emitApplied works under. A missing io is logged, never thrown: the write has
 * already committed and failing here would report a success as a failure.
 */
export function emitFormTerminated(workspaceId: string, result: CompleteFormResult): void {
  let io: Server;
  try {
    io = getIo();
  } catch (err) {
    logger.warn('forms', 'skipping realtime emit: socket server not initialised', {
      workspaceId,
      conversationId: result.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  emitMessageToRooms(
    io,
    result.conversationId,
    toPlayerView(result.posted),
    toAgentView(result.posted),
  );
  if (result.noAgentsOnlinePosted) {
    emitMessageToRooms(
      io,
      result.conversationId,
      toPlayerView(result.noAgentsOnlinePosted),
      toAgentView(result.noAgentsOnlinePosted),
    );
  }
  emitPhaseChanged(io, result.conversationId, {
    conversation_id: result.conversationId,
    confirm_phase: 'none',
  });
  emitInboxChanged(io, workspaceId, result.conversationId, 'open');
  if (result.notification) {
    emitNotificationNew(io, result.notification.agent_id, result.notification);
  }
}
