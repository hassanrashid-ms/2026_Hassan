import { eq } from 'drizzle-orm';
import type { AssignmentVia, NotificationView } from '@support/types';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { conversation, notification, workspace } from '../../shared/db/schema/index.ts';

export type NotifyAgentParams = {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  via: AssignmentVia;
};

export function toNotificationView(row: typeof notification.$inferSelect): NotificationView {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    agent_id: row.agentId,
    type: row.type,
    conversation_id: row.conversationId,
    payload: row.payload,
    read_at: row.readAt ? row.readAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * The single write path for a ticket-assignment notification, called inside
 * the same transaction as the assignment write itself (right after
 * appendEvent), from every current assignment site — claim, take-over,
 * reassign, sweep, bot handoff, reopen. A future assignment path wires in with
 * one call here, nothing else in the notification system needs to change.
 *
 * Looks up the conversation's number/priority and the workspace's
 * name/slug itself so call sites stay one-liners; snapshotted into payload
 * because a later rename must not rewrite what this notification said at
 * the time.
 */
export async function notifyAgent(tx: Tx, params: NotifyAgentParams): Promise<NotificationView> {
  const [conv] = await tx
    .select({ number: conversation.number, priority: conversation.priority })
    .from(conversation)
    .where(eq(conversation.id, params.conversationId))
    .limit(1);

  const [ws] = await tx
    .select({ name: workspace.name, slug: workspace.slug })
    .from(workspace)
    .where(eq(workspace.id, params.workspaceId))
    .limit(1);

  const [row] = await tx
    .insert(notification)
    .values({
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      type: 'ticket_assigned',
      conversationId: params.conversationId,
      payload: {
        ticket_number: conv?.number ?? null,
        priority: conv?.priority ?? null,
        via: params.via,
        workspace_name: ws?.name ?? null,
        workspace_slug: ws?.slug ?? null,
      },
    })
    .returning();

  return toNotificationView(row!);
}
