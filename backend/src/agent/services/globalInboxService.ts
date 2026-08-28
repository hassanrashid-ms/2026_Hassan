import { and, desc, eq, inArray } from 'drizzle-orm';
import pLimit from 'p-limit';
import type { AgentConversationSummary } from '@support/types';
import { agent, conversation, message, player } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import {
  listActiveMembershipsForAgent,
  listAllWorkspaces,
} from '../../shared/db/workspaceMembership.ts';
import { getConversationTags } from './tagsService.ts';
import { logger } from '../../shared/logging/logger.ts';

// This is the authenticated agent's own assigned queue merged across
// workspaces, never every agent's tickets — that's what the per-workspace
// Tickets tab is for. An admin gets every workspace scattered, but still
// only the tickets assigned to *them*, same as anyone else.
export type GlobalInboxTicket = AgentConversationSummary & {
  workspace: { id: string; slug: string; name: string };
};
export type GlobalInboxResponse = {
  conversations: GlobalInboxTicket[];
  failed_workspaces: string[];
};

const PER_WORKSPACE_CAP = 50;
const SCATTER_CONCURRENCY = 10;
// Excludes 'resolved' and 'closed' — "active tickets" per the design doc.
const OPEN_STATUSES: (typeof conversation.status.enumValues)[number][] = [
  'new',
  'bot_active',
  'open',
  'awaiting_player',
  'escalated',
];

type WorkspaceTarget = { id: string; slug: string; name: string };

async function getWorkspaceInboxSlice(
  ws: WorkspaceTarget,
  agentId: string,
): Promise<GlobalInboxTicket[]> {
  return withWorkspace(ws.id, async (tx) => {
    const rows = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
        externalPlayerId: player.externalId,
        confirmPhase: conversation.confirmPhase,
        assignedAgentId: conversation.assignedAgentId,
        assignedAgentName: agent.displayName,
        priority: conversation.priority,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .where(
        and(inArray(conversation.status, OPEN_STATUSES), eq(conversation.assignedAgentId, agentId)),
      )
      .orderBy(conversation.priority, conversation.createdAt)
      .limit(PER_WORKSPACE_CAP);

    const tickets: GlobalInboxTicket[] = [];
    for (const row of rows) {
      const [last] = await tx
        .select({ body: message.body, createdAt: message.createdAt })
        .from(message)
        .where(eq(message.conversationId, row.id))
        .orderBy(desc(message.seq))
        .limit(1);
      const tags = await getConversationTags(tx, row.id);

      tickets.push({
        id: row.id,
        player: { external_player_id: row.externalPlayerId },
        status: row.status,
        confirm_phase: row.confirmPhase,
        last_message_preview: last?.body ?? null,
        last_message_at: last?.createdAt.toISOString() ?? null,
        assigned_agent_id: row.assignedAgentId,
        assigned_agent_name: row.assignedAgentName,
        priority: row.priority,
        tags,
        workspace: ws,
      });
    }
    return tickets;
  });
}

function compareTickets(a: GlobalInboxTicket, b: GlobalInboxTicket): number {
  if (a.priority !== b.priority) return a.priority.localeCompare(b.priority);
  const aTime = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
  const bTime = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
  return bTime - aTime;
}

export async function getGlobalInbox(ctx: AgentContext): Promise<GlobalInboxResponse> {
  const targets: WorkspaceTarget[] = ctx.isAdmin
    ? (await listAllWorkspaces()).map((w) => ({
        id: w.workspaceId,
        slug: w.workspaceSlug,
        name: w.workspaceName,
      }))
    : (await listActiveMembershipsForAgent(ctx.agentId)).map((m) => ({
        id: m.workspaceId,
        slug: m.workspaceSlug,
        name: m.workspaceName,
      }));

  const limit = pLimit(SCATTER_CONCURRENCY);
  const failedWorkspaces: string[] = [];
  const slices = await Promise.all(
    targets.map((ws) =>
      limit(async () => {
        try {
          return await getWorkspaceInboxSlice(ws, ctx.agentId);
        } catch (error) {
          logger.error(
            'global_inbox',
            `workspace ${ws.id} inbox slice failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          failedWorkspaces.push(ws.id);
          return [];
        }
      }),
    ),
  );

  const conversations = slices.flat().sort(compareTickets);
  return { conversations, failed_workspaces: failedWorkspaces };
}
