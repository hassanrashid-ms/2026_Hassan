import type {
  FormAnswerResponse,
  FormTerminateResponse,
  NewTicketResponse,
  PlayerMessageView,
  PlayerMessagesResponse,
  ResolutionAnswerResponse,
} from '@support/types';
import { apiCall } from '../../../lib/httpClient.ts';

export function fetchPlayerMessages(
  token: string,
  sessionId: string,
): Promise<PlayerMessagesResponse> {
  return apiCall<PlayerMessagesResponse>(
    `/surface/messages?session_id=${encodeURIComponent(sessionId)}`,
    token,
  );
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
  });
}

/**
 * "Open a new ticket" on the resolved banner. Carries no conversation id for the
 * same reason the rest of this file does not: the server closes the player's
 * latest thread and returns the fresh one it opened.
 */
export function openNewTicket(token: string, sessionId?: string): Promise<NewTicketResponse> {
  return apiCall(`/surface/new-ticket`, token, {
    method: 'POST',
    body: JSON.stringify(sessionId ? { session_id: sessionId } : {}),
  });
}

export function markPlayerMessagesRead(token: string, upToSeq: number): Promise<{ ok: true }> {
  return apiCall(`/surface/messages/read`, token, {
    method: 'POST',
    body: JSON.stringify({ up_to_seq: upToSeq }),
  });
}

/**
 * The banner's Yes/No. Carries no source and no conversation id: the backend
 * decides what the tap means from confirm_phase, which is why the webview never
 * branches on it.
 */
export function answerResolution(
  token: string,
  helped: boolean,
  sessionId?: string,
): Promise<ResolutionAnswerResponse> {
  return apiCall(`/surface/resolution-answer`, token, {
    method: 'POST',
    body: JSON.stringify(sessionId ? { helped, session_id: sessionId } : { helped }),
  });
}

/**
 * One question, one request. Considered and rejected: collecting every answer
 * client-side and submitting once — it loses everything if the player drops
 * mid-form, and to preserve partial answers on skip it has to send them anyway.
 */
export function postFormAnswer(
  token: string,
  fieldKey: string,
  value: unknown,
  sessionId?: string,
): Promise<FormAnswerResponse> {
  return apiCall(`/surface/form/answer`, token, {
    method: 'POST',
    body: JSON.stringify(
      sessionId
        ? { field_key: fieldKey, value, session_id: sessionId }
        : { field_key: fieldKey, value },
    ),
  });
}

export function submitForm(token: string, sessionId?: string): Promise<FormTerminateResponse> {
  return apiCall(`/surface/form/submit`, token, {
    method: 'POST',
    body: JSON.stringify(sessionId ? { session_id: sessionId } : {}),
  });
}

export function skipForm(token: string, sessionId?: string): Promise<FormTerminateResponse> {
  return apiCall(`/surface/form/skip`, token, {
    method: 'POST',
    body: JSON.stringify(sessionId ? { session_id: sessionId } : {}),
  });
}
