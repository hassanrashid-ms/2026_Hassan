import type { PlayerMessageView, PlayerMessagesResponse, ResolutionAnswerResponse } from '@support/types'
import { apiCall } from '../../../lib/httpClient.ts'

export function fetchPlayerMessages(token: string, sessionId: string): Promise<PlayerMessagesResponse> {
  return apiCall<PlayerMessagesResponse>(`/surface/messages?session_id=${encodeURIComponent(sessionId)}`, token)
}

/**
 * `sessionId` comes straight from the parsed URL, so it costs no latency and
 * does not wait on bootstrap. The server verifies it and degrades to an
 * unattributed event if it cannot — sending never depends on it.
 */
export function sendPlayerMessage(
  token: string,
  body: string,
  sessionId?: string,
): Promise<{ conversation_id: string; message: PlayerMessageView }> {
  return apiCall(`/surface/messages`, token, {
    method: 'POST',
    body: JSON.stringify(sessionId ? { body, session_id: sessionId } : { body }),
  })
}

export function markPlayerMessagesRead(token: string, upToSeq: number): Promise<{ ok: true }> {
  return apiCall(`/surface/messages/read`, token, { method: 'POST', body: JSON.stringify({ up_to_seq: upToSeq }) })
}

/**
 * The banner's Yes/No. Carries no source and no conversation id: the backend
 * decides what the tap means from confirm_phase, which is why the webview never
 * branches on it.
 */
export function answerResolution(token: string, helped: boolean, sessionId?: string): Promise<ResolutionAnswerResponse> {
  return apiCall(`/surface/resolution-answer`, token, {
    method: 'POST',
    body: JSON.stringify(sessionId ? { helped, session_id: sessionId } : { helped }),
  })
}
