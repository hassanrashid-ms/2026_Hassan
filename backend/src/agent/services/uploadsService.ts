import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { RequestUploadBody, RequestUploadResponse } from '@support/types';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  deleteObject,
  presignPutObject,
} from '../../shared/storage/presign.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

export function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
}

export function buildPendingKey(workspaceId: string, agentId: string, contentType: string): string {
  return `pending/${workspaceId}/${agentId}/${randomUUID()}.${extensionFor(contentType)}`;
}

export type RequestUploadResult =
  | ({ outcome: 'ok' } & RequestUploadResponse)
  | { outcome: 'invalid_media_type' }
  | { outcome: 'too_large' };

export async function requestUpload(
  ctx: AgentContext,
  body: z.infer<typeof RequestUploadBody>,
): Promise<RequestUploadResult> {
  if (
    !ALLOWED_IMAGE_MIME_TYPES.includes(
      body.content_type as (typeof ALLOWED_IMAGE_MIME_TYPES)[number],
    )
  ) {
    return { outcome: 'invalid_media_type' };
  }
  if (body.byte_size > MAX_ATTACHMENT_BYTES) {
    return { outcome: 'too_large' };
  }

  const key = buildPendingKey(ctx.workspaceId, ctx.agentId, body.content_type);
  const { url, expiresAt } = await presignPutObject({
    key,
    contentType: body.content_type,
    contentLength: body.byte_size,
  });
  return { outcome: 'ok', key, upload_url: url, expires_at: expiresAt };
}

/**
 * Ownership is the key's own {agentId} path segment, not a DB lookup — no row
 * exists for a pending upload by design. 'not_owner' maps to 404 at the
 * controller, matching the repo's "404 not 403" convention.
 */
export async function cancelUpload(ctx: AgentContext, key: string): Promise<'ok' | 'not_owner'> {
  const expectedPrefix = `pending/${ctx.workspaceId}/${ctx.agentId}/`;
  if (!key.startsWith(expectedPrefix)) return 'not_owner';
  await deleteObject(key);
  return 'ok';
}
