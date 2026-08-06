import type { PlayerMessageView, PlayerMessagesResponse } from '@support/types'
import { apiCall } from './httpClient.ts'

export function fetchPlayerMessages(token: string, sessionId: string): Promise<PlayerMessagesResponse> {
  return apiCall<PlayerMessagesResponse>(`/surface/messages?session_id=${encodeURIComponent(sessionId)}`, token)
}

export function sendPlayerMessage(
  token: string,
  body: string,
): Promise<{ conversation_id: string; message: PlayerMessageView }> {
  return apiCall(`/surface/messages`, token, { method: 'POST', body: JSON.stringify({ body }) })
}

export function markPlayerMessagesRead(token: string, upToSeq: number): Promise<{ ok: true }> {
  return apiCall(`/surface/messages/read`, token, { method: 'POST', body: JSON.stringify({ up_to_seq: upToSeq }) })
}
