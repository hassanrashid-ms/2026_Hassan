import { eq } from 'drizzle-orm';
import { conversation, subintent } from '../../shared/db/schema/index.ts';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';

type ConversationPriority = 'p1' | 'p2' | 'p3' | 'p4';

/**
 * Applies a subintent's `default_priority` onto a conversation, called from
 * every place a conversation's subintent gets written (bot's classifyIfUnset,
 * agent's reclassifyConversation). Manual always wins: skipped entirely once
 * `priorityManuallySet` is true, and a no-op (no write, no event) when the
 * subintent has no default or the default already matches the current value.
 * See docs/specs/2026-08-27-conversation-priority-design.md.
 */
export async function applySubintentDefaultPriority(
  tx: Tx,
  params: {
    workspaceId: string;
    conversationId: string;
    subintentId: string;
    currentPriority: ConversationPriority;
    priorityManuallySet: boolean;
    actorId: string | null;
    actorType: 'bot' | 'agent';
  },
): Promise<void> {
  if (params.priorityManuallySet) return;

  const [target] = await tx
    .select({ defaultPriority: subintent.defaultPriority })
    .from(subintent)
    .where(eq(subintent.id, params.subintentId))
    .limit(1);

  if (!target?.defaultPriority || target.defaultPriority === params.currentPriority) return;

  await tx
    .update(conversation)
    .set({ priority: target.defaultPriority })
    .where(eq(conversation.id, params.conversationId));

  await appendEvent(tx, {
    workspaceId: params.workspaceId,
    type: 'conversation_priority_changed',
    conversationId: params.conversationId,
    actorId: params.actorId,
    actorType: params.actorType,
    payload: {
      from: params.currentPriority,
      to: target.defaultPriority,
      reason: 'subintent_default',
    },
  });
}
