import type { Server } from 'socket.io'
import type { MessageReadEvent } from '@support/types'
import { agentRoom, inboxRoom, playerRoom } from './rooms.ts'

/**
 * Payloads are `unknown` on purpose: this module is transport, not
 * domain-aware. The caller (a surface/agent service, after its transaction has
 * committed) already ran the row through toPlayerView/toAgentView and passes
 * the finished view object straight through.
 */
export function emitMessageToRooms(
  io: Server,
  conversationId: string,
  playerPayload: unknown,
  agentPayload: unknown,
): void {
  io.to(agentRoom(conversationId)).emit('message:new', agentPayload)
  if (playerPayload !== null) {
    io.to(playerRoom(conversationId)).emit('message:new', playerPayload)
  }
}

/** id and new status only — never the full conversation row. */
export function emitInboxChanged(io: Server, workspaceId: string, conversationId: string, status: string): void {
  io.to(inboxRoom(workspaceId)).emit('conversation:changed', { conversation_id: conversationId, status })
}

/**
 * Routed by audience rather than by conversation alone: a receipt goes to whoever
 * *wrote* the messages, never back to whoever read them. Unlike
 * emitMessageToRooms this payload is typed — it is a fixed four-field contract,
 * not a serializer's output passed through.
 */
export function emitReadReceipt(io: Server, audience: 'player' | 'agents', payload: MessageReadEvent): void {
  const room = audience === 'player' ? playerRoom(payload.conversation_id) : agentRoom(payload.conversation_id)
  io.to(room).emit('message:read', payload)
}
