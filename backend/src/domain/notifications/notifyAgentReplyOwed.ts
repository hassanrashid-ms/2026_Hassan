import { eq } from 'drizzle-orm';
import type { NotificationView } from '@support/types';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { conversation, notification, workspace } from '../../shared/db/schema/index.ts';
import { toNotificationView } from './notifyAgent.ts';

export type NotifyAgentReplyOwedParams = {
  workspaceId: string;
  agentId: string;
  conversationId: string;
};

export async function notifyAgentReplyOwed(
  tx: Tx,
  params: NotifyAgentReplyOwedParams,
): Promise<NotificationView> {
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
      type: 'reply_owed',
      conversationId: params.conversationId,
      payload: {
        ticket_number: conv?.number ?? null,
        priority: conv?.priority ?? null,
        workspace_name: ws?.name ?? null,
        workspace_slug: ws?.slug ?? null,
      },
    })
    .returning();

  return toNotificationView(row!);
}
