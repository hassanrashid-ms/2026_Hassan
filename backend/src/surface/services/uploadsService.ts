import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { RequestUploadBody, RequestUploadResponse } from '@support/types';
import {
  ALLOWED_CHAT_ATTACHMENT_MIME_TYPES,
  deleteObject,
  maxBytesForAttachment,
  presignPutObject,
} from '../../shared/storage/presign.ts';
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts';

function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'video/mp4':
      return 'mp4';
    case 'video/webm':
      return 'webm';
    default:
      return 'bin';
  }
}

export function buildPendingPlayerKey(
  workspaceId: string,
  playerId: string,
  contentType: string,
): string {
  return `pending/${workspaceId}/${playerId}/${randomUUID()}.${extensionFor(contentType)}`;
}

export type RequestUploadResult =
  | ({ outcome: 'ok' } & RequestUploadResponse)
  | { outcome: 'invalid_media_type' }
  | { outcome: 'too_large' };

export async function requestPlayerUpload(
  ctx: PlayerContext,
  body: z.infer<typeof RequestUploadBody>,
): Promise<RequestUploadResult> {
  if (
    !ALLOWED_CHAT_ATTACHMENT_MIME_TYPES.includes(
      body.content_type as (typeof ALLOWED_CHAT_ATTACHMENT_MIME_TYPES)[number],
    )
  ) {
    return { outcome: 'invalid_media_type' };
  }
  if (body.byte_size > maxBytesForAttachment(body.content_type)) {
    return { outcome: 'too_large' };
  }
  const key = buildPendingPlayerKey(ctx.workspaceId, ctx.playerId, body.content_type);
  const { url, expiresAt } = await presignPutObject({
    key,
    contentType: body.content_type,
    contentLength: body.byte_size,
  });
  return { outcome: 'ok', key, upload_url: url, expires_at: expiresAt };
}

/**
 * Ownership is the key's own {playerId} path segment, not a DB lookup — no row
 * exists for a pending upload by design. 'not_owner' maps to 404 at the
 * controller, matching the repo's "404 not 403" convention.
 */
export async function cancelPlayerUpload(
  ctx: PlayerContext,
  key: string,
): Promise<'ok' | 'not_owner'> {
  const expectedPrefix = `pending/${ctx.workspaceId}/${ctx.playerId}/`;
  if (!key.startsWith(expectedPrefix)) return 'not_owner';
  await deleteObject(key);
  return 'ok';
}
