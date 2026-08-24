import { randomUUID } from 'node:crypto';
import { and, eq, lte, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { MarkAgentReadBody, SendAgentMessageBody, type AgentMessageView } from '@support/types';
import { postMessage, toAgentView, toPlayerView } from '../../domain/conversations/index.ts';
import { attachment, conversation, message } from '../../shared/db/schema/index.ts';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  copyObject,
  deleteObject,
  headObject,
} from '../../shared/storage/presign.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import {
  emitInboxChanged,
  emitMessageToRooms,
  emitReadReceipt,
} from '../../shared/realtime/emit.ts';
import { getIo } from '../../shared/realtime/socketServer.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import { extensionFor } from './uploadsService.ts';
import { logger } from '../../shared/logging/logger.ts';

export type SendAgentMessageResult =
  | { outcome: 'ok'; message: AgentMessageView }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'attachment_not_found' }
  | { outcome: 'attachment_mismatch' };

export async function sendAgentMessage(
  ctx: AgentContext,
  body: z.infer<typeof SendAgentMessageBody>,
): Promise<SendAgentMessageResult> {
  let claimedDestKey: string | null = null;
  let pendingKeyToDelete: string | null = null;

  if (body.attachment) {
    // Ownership check on a fully client-supplied key: only this agent's own
    // pending prefix may be claimed. Wrong-tenant/wrong-agent keys collapse
    // into the same outcome as "missing" — same "404 not 403" convention as
    // cancelUpload — so a claim attempt never reveals whether some other
    // agent's object exists at all.
    const expectedPrefix = `pending/${ctx.workspaceId}/${ctx.agentId}/`;
    if (!body.attachment.key.startsWith(expectedPrefix)) {
      return { outcome: 'attachment_not_found' };
    }

    const real = await headObject(body.attachment.key);
    if (!real) return { outcome: 'attachment_not_found' };
    if (
      real.contentType !== body.attachment.mime_type ||
      real.contentLength !== body.attachment.byte_size
    ) {
      return { outcome: 'attachment_mismatch' };
    }
    // Defense-in-depth: re-check the allowlist/size cap against the real,
    // HEAD-verified values at claim time too, not only at presign time —
    // presign-time checks alone would trust whatever the object turned out
    // to actually be.
    if (
      !ALLOWED_IMAGE_MIME_TYPES.includes(
        real.contentType as (typeof ALLOWED_IMAGE_MIME_TYPES)[number],
      ) ||
      real.contentLength > MAX_ATTACHMENT_BYTES
    ) {
      return { outcome: 'attachment_mismatch' };
    }

    // Server-generated key only: the extension comes from the HEAD-verified
    // content type, never parsed out of the client-supplied key.
    claimedDestKey = `ws/${ctx.workspaceId}/attachments/${randomUUID()}.${extensionFor(real.contentType)}`;
    await copyObject({ sourceKey: body.attachment.key, destKey: claimedDestKey });
    pendingKeyToDelete = body.attachment.key;
  }

  const messageBody = body.body.trim().length > 0 ? body.body : body.attachment!.filename;

  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx
      .select({
        id: conversation.id,
        assignedAgentId: conversation.assignedAgentId,
        status: conversation.status,
      })
      .from(conversation)
      .where(eq(conversation.id, body.conversation_id))
      .limit(1);

    if (!found) return { outcome: 'not_found' } as const;
    if (found.assignedAgentId !== ctx.agentId) return { outcome: 'forbidden' } as const;

    const posted = await postMessage(tx, {
      workspaceId: ctx.workspaceId,
      conversationId: found.id,
      authorType: 'agent',
      actorId: ctx.agentId,
      authorAgentId: ctx.agentId,
      body: messageBody,
      visibility: body.visibility,
    });

    let attachmentRow: { id: string; filename: string; mimeType: string; byteSize: number } | null =
      null;
    if (body.attachment && claimedDestKey) {
      const [insertedAttachment] = await tx
        .insert(attachment)
        .values({
          workspaceId: ctx.workspaceId,
          messageId: posted.id,
          storageKey: claimedDestKey,
          filename: body.attachment.filename,
          mimeType: body.attachment.mime_type,
          byteSize: body.attachment.byte_size,
        })
        .returning();
      attachmentRow = {
        id: insertedAttachment!.id,
        filename: body.attachment.filename,
        mimeType: body.attachment.mime_type,
        byteSize: body.attachment.byte_size,
      };
    }

    let inboxStatus: 'awaiting_player' | null = null;
    if (body.visibility !== 'internal' && found.status === 'open') {
      await tx
        .update(conversation)
        .set({ status: 'awaiting_player' })
        .where(eq(conversation.id, found.id));
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'conversation_awaiting_player',
        conversationId: found.id,
        actorId: ctx.agentId,
        actorType: 'agent',
      });
      inboxStatus = 'awaiting_player';
    }

    return { outcome: 'ok', posted, attachmentRow, inboxStatus } as const;
  });

  // Best-effort cleanup of the pending original — only after the transaction
  // committed, so a failed transaction leaves the pending object in place
  // (still cancellable/reusable) rather than deleting it out from under a
  // send that didn't actually happen.
  if (result.outcome === 'ok' && pendingKeyToDelete) {
    try {
      await deleteObject(pendingKeyToDelete);
    } catch (error) {
      // Genuinely best-effort: the message already committed, so a transient
      // storage error here must never surface as a failed send to the agent
      // (that invites an accidental duplicate resend of a message that went
      // through). Log and move on.
      logger.warn(
        'attachments',
        `failed to delete pending object ${pendingKeyToDelete} after claim: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (result.outcome !== 'ok') return result;

  const agentView: AgentMessageView = {
    ...toAgentView(result.posted),
    attachment: result.attachmentRow
      ? {
          id: result.attachmentRow.id,
          filename: result.attachmentRow.filename,
          mime_type: result.attachmentRow.mimeType,
          byte_size: result.attachmentRow.byteSize,
          url: null, // populated only by the GET read path (Task 5), never on the immediate send response
        }
      : null,
  };
  const playerView = toPlayerView(result.posted);
  emitMessageToRooms(getIo(), body.conversation_id, playerView, agentView);
  if (result.inboxStatus) {
    emitInboxChanged(getIo(), ctx.workspaceId, body.conversation_id, result.inboxStatus);
  }
  return { outcome: 'ok', message: agentView };
}

export type MarkReadResult = { conversationId: string; upToSeq: number; readAt: Date } | null;

export async function markAgentMessagesRead(
  ctx: AgentContext,
  body: z.infer<typeof MarkAgentReadBody>,
): Promise<MarkReadResult> {
  const readAt = new Date();

  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.id, body.conversation_id))
      .limit(1);
    if (!found) return null;

    const updated = await tx
      .update(message)
      .set({ deliveryState: 'read', readAt })
      .where(
        and(
          eq(message.conversationId, found.id),
          eq(message.authorType, 'player'),
          ne(message.deliveryState, 'read'),
          lte(message.seq, body.up_to_seq),
        ),
      )
      .returning({ seq: message.seq });

    if (updated.length === 0) return null;
    return { conversationId: found.id, upToSeq: Math.max(...updated.map((r) => r.seq)), readAt };
  });

  if (result) {
    emitReadReceipt(getIo(), 'player', {
      conversation_id: result.conversationId,
      up_to_seq: result.upToSeq,
      reader_type: 'agent',
      read_at: result.readAt.toISOString(),
    });
  }

  return result;
}
