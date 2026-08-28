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
 *
 * `attachment`/`formFieldKey` mirror agentApi.sendAgentMessage's own optional
 * pair (Phase 1): a claim-on-send of a key returned by requestUpload, plus —
 * only when this send answers a form's `attachment` field — the field key
 * FormCard's own local progress names, since form state is never
 * server-refetched mid-form.
 */
export function sendPlayerMessage(
  token: string,
  body: string,
  sessionId?: string,
  attachment?: { key: string; filename: string; mimeType: string; byteSize: number },
  formFieldKey?: string,
): Promise<{ conversation_id: string | null; message: PlayerMessageView | null }> {
  return apiCall(`/surface/messages`, token, {
    method: 'POST',
    body: JSON.stringify({
      body,
      session_id: sessionId,
      attachment: attachment
        ? {
            key: attachment.key,
            filename: attachment.filename,
            mime_type: attachment.mimeType,
            byte_size: attachment.byteSize,
          }
        : undefined,
      form_field_key: formFieldKey,
    }),
  });
}

export type RequestUploadResult = { key: string; upload_url: string; expires_at: string };

/**
 * The player-token equivalent of agentApi.ts's requestUpload/putFileToUploadUrl/
 * cancelUpload (Phase 1) — same presign-then-PUT flow, hitting `/surface/uploads`
 * instead of `/agent/uploads` since this token carries a player identity.
 */
export function requestUpload(
  token: string,
  file: { filename: string; contentType: string; byteSize: number },
): Promise<RequestUploadResult> {
  return apiCall(`/surface/uploads`, token, {
    method: 'POST',
    body: JSON.stringify({
      filename: file.filename,
      content_type: file.contentType,
      byte_size: file.byteSize,
    }),
  });
}

/**
 * XHR, not fetch — fetch has no upload-progress event, and the pretty
 * uploading UI needs a real percentage, not a fake one.
 */
export function putFileToUploadUrl(
  uploadUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new Error(`Upload failed with ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
}

export function cancelUpload(token: string, key: string): Promise<void> {
  return apiCall(`/surface/uploads/${key}`, token, { method: 'DELETE' });
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
