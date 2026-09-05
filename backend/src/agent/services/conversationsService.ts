import {
  and,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  isNotNull,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AgentConversationSummary, AgentMessageView, NotificationView } from '@support/types';
import {
  applySubintentDefaultPriority,
  postMessage,
  toAgentView,
  type PostedMessageRow,
} from '../../domain/conversations/index.ts';
import { notifyAgent } from '../../domain/notifications/notifyAgent.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts';
import {
  agent,
  attachment,
  conversation,
  conversationTag,
  message,
  player,
  resolutionCycle,
  subintent,
  workspace,
  workspaceMember,
} from '../../shared/db/schema/index.ts';
import { presignGetObject } from '../../shared/storage/presign.ts';
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import { getConversationTags } from './tagsService.ts';
import { getPresenceStatusBatch } from '../../shared/realtime/presence.ts';
import { logger } from '../../shared/logging/logger.ts';

export type ConversationsFilter =
  | 'unassigned'
  | 'mine'
  | 'agentAssigned'
  | 'botHandling'
  | 'escalated'
  | 'resolved'
  | 'closed'
  | 'all';

export type ConversationsListFilters = {
  priority?: (typeof conversation.priority.enumValues)[number][];
  labelIds?: string[];
  subintentIds?: string[];
  assigneeIds?: string[];
  olderThanHours?: number;
  q?: string;
  cursor?: string;
  createdFrom?: string;
  createdTo?: string;
  statuses?: Exclude<ConversationsFilter, 'all' | 'mine'>[];
  sortBy?: SortKey;
  sortDir?: 'asc' | 'desc';
  sortBy2?: SortKey;
  sortDir2?: 'asc' | 'desc';
};

export type ConversationsPage = {
  conversations: AgentConversationSummary[];
  nextCursor: string | null;
};

const ACTIVE_AGENT_STATUSES: (typeof conversation.status.enumValues)[number][] = [
  'open',
  'awaiting_player',
  'escalated',
];
const UNASSIGNED_STATUSES: (typeof conversation.status.enumValues)[number][] = [
  'open',
  'escalated',
];

const ALL_QUEUE_STATUSES: Exclude<ConversationsFilter, 'all' | 'mine'>[] = [
  'unassigned',
  'botHandling',
  'agentAssigned',
  'escalated',
  'resolved',
  'closed',
];

// Reused by the 'all' merged mode so a conversation only counts as
// resolved/closed there under the exact same 7-day-window + latest-cycle
// rule the dedicated resolved/closed queues already enforce — expressed as
// an EXISTS condition (not a join) so it composes into the single-query,
// no-row-multiplication shape the other five queues use.
function resolvedOrClosedCondition(tx: Tx, status: 'resolved' | 'closed') {
  const cycle = alias(resolutionCycle, `${status}_cycle`);
  const laterCycle = alias(resolutionCycle, `${status}_later_cycle`);
  const timestampCol = status === 'resolved' ? cycle.resolvedAt : cycle.closedAt;
  return and(
    eq(conversation.status, status),
    exists(
      tx
        .select({ one: sql`1` })
        .from(cycle)
        .where(
          and(
            eq(cycle.conversationId, conversation.id),
            isNotNull(timestampCol),
            sql`${timestampCol} >= now() - interval '7 days'`,
            notExists(
              tx
                .select({ one: sql`1` })
                .from(laterCycle)
                .where(
                  and(
                    eq(laterCycle.conversationId, cycle.conversationId),
                    sql`${laterCycle.cycleNo} > ${cycle.cycleNo}`,
                  ),
                ),
            ),
          ),
        ),
    ),
  );
}

function queueCondition(tx: Tx, queue: Exclude<ConversationsFilter, 'all' | 'mine'>) {
  switch (queue) {
    case 'unassigned':
      return and(
        isNull(conversation.assignedAgentId),
        inArray(conversation.status, UNASSIGNED_STATUSES),
      );
    case 'agentAssigned':
      return and(
        isNotNull(conversation.assignedAgentId),
        inArray(conversation.status, ACTIVE_AGENT_STATUSES),
      );
    case 'botHandling':
      return eq(conversation.status, 'bot_active');
    case 'escalated':
      return eq(conversation.status, 'escalated');
    case 'resolved':
      return resolvedOrClosedCondition(tx, 'resolved');
    case 'closed':
      return resolvedOrClosedCondition(tx, 'closed');
  }
}

const PAGE_SIZE = 25;

type StatusCursor = { priority: string; createdAt: string; id: string };

function encodeCursor(payload: StatusCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeStatusCursor(cursor: string): StatusCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed?.priority === 'string' &&
      typeof parsed?.createdAt === 'string' &&
      typeof parsed?.id === 'string'
    ) {
      return parsed as StatusCursor;
    }
    return null;
  } catch {
    return null;
  }
}

export type SortKey =
  | 'player'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'lastMessage'
  | 'tags'
  | 'created'
  | 'subintent'
  | 'number';

type AllCursor = { primary: string; secondary: string; id: string };

function encodeAllCursor(payload: AllCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeAllCursor(cursor: string): AllCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed?.primary === 'string' &&
      typeof parsed?.secondary === 'string' &&
      typeof parsed?.id === 'string'
    ) {
      return parsed as AllCursor;
    }
    return null;
  } catch {
    return null;
  }
}

type TimelineCursor = { ts: string; id: string };

function encodeTimelineCursor(payload: TimelineCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeTimelineCursor(cursor: string): TimelineCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed?.ts === 'string' && typeof parsed?.id === 'string') {
      return parsed as TimelineCursor;
    }
    return null;
  } catch {
    return null;
  }
}

// Self-join alias for the "only the latest resolution_cycle row per
// conversation" NOT EXISTS pattern below — a conversation can carry multiple
// historical cycles (resolve → reopen → resolve again), and only the most
// recent one reflects why the conversation is *currently* resolved/closed.
const latestCycle = alias(resolutionCycle, 'latest_cycle');

function extraFilterConditions(extra: ConversationsListFilters) {
  const conditions = [];
  if (extra.priority?.length) conditions.push(inArray(conversation.priority, extra.priority));
  if (extra.subintentIds?.length)
    conditions.push(inArray(conversation.subintentId, extra.subintentIds));
  if (extra.assigneeIds?.length)
    conditions.push(inArray(conversation.assignedAgentId, extra.assigneeIds));
  if (extra.labelIds?.length) {
    conditions.push(
      exists(
        sql`(select 1 from ${conversationTag} where ${conversationTag.conversationId} = ${conversation.id} and ${conversationTag.removedAt} is null and ${conversationTag.tagId} in ${extra.labelIds})`,
      ),
    );
  }
  if (extra.createdFrom)
    conditions.push(sql`${conversation.createdAt} >= ${extra.createdFrom}::date`);
  if (extra.createdTo)
    conditions.push(sql`${conversation.createdAt} < (${extra.createdTo}::date + interval '1 day')`);
  if (extra.q) {
    const term = `%${extra.q}%`;
    const qNum = parseInt(extra.q, 10);
    const numMatch = !isNaN(qNum) ? eq(conversation.number, qNum) : undefined;
    const qCond = or(numMatch, ilike(player.externalId, term), ilike(subintent.name, term));
    if (qCond) conditions.push(qCond);
  }
  return conditions;
}

export async function listConversations(
  ctx: AgentContext,
  filter: ConversationsFilter,
  extra: ConversationsListFilters = {},
): Promise<ConversationsPage> {
  if (filter === 'all') return listAllConversations(ctx, extra);
  if (filter === 'resolved' || filter === 'closed') {
    return listResolvedOrClosedConversations(ctx, filter, extra);
  }
  return withWorkspace(ctx.workspaceId, async (tx) => {
    // Cursors round-trip through a JS Date (millisecond precision), while
    // conversation.createdAt is a microsecond-precision timestamptz — two rows
    // inserted within the same millisecond would otherwise sort differently in
    // SQL than the cursor comparison expects. Truncate both sides to
    // milliseconds so ORDER BY and the cursor condition agree exactly.
    const createdAtMs = sql`date_trunc('millisecond', ${conversation.createdAt})`;
    const cursor = extra.cursor ? decodeStatusCursor(extra.cursor) : null;
    const cursorCondition = cursor
      ? sql`(${conversation.priority}, ${createdAtMs}, ${conversation.id}) > (${cursor.priority}::conversation_priority, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : undefined;

    const rows = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
        externalPlayerId: player.externalId,
        confirmPhase: conversation.confirmPhase,
        assignedAgentId: conversation.assignedAgentId,
        assignedAgentName: agent.displayName,
        priority: conversation.priority,
        createdAt: conversation.createdAt,
        subintentId: subintent.id,
        subintentName: subintent.name,
        number: conversation.number,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
      .where(
        and(
          filter === 'mine'
            ? and(
                eq(conversation.assignedAgentId, ctx.agentId),
                inArray(conversation.status, ACTIVE_AGENT_STATUSES),
              )
            : filter === 'agentAssigned'
              ? and(
                  isNotNull(conversation.assignedAgentId),
                  inArray(conversation.status, ACTIVE_AGENT_STATUSES),
                )
              : filter === 'botHandling'
                ? eq(conversation.status, 'bot_active')
                : filter === 'escalated'
                  ? eq(conversation.status, 'escalated')
                  : and(
                      isNull(conversation.assignedAgentId),
                      inArray(conversation.status, UNASSIGNED_STATUSES),
                    ),
          cursorCondition,
          ...extraFilterConditions(extra),
        ),
      )
      .orderBy(conversation.priority, createdAtMs, conversation.id)
      .limit(PAGE_SIZE + 1);

    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const summaries: AgentConversationSummary[] = [];
    for (const row of pageRows) {
      const [last] = await tx
        .select({ body: message.body, createdAt: message.createdAt })
        .from(message)
        .where(eq(message.conversationId, row.id))
        .orderBy(desc(message.seq))
        .limit(1);
      const tags = await getConversationTags(tx, row.id);

      summaries.push({
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
        created_at: row.createdAt.toISOString(),
        subintent: row.subintentId ? { id: row.subintentId, name: row.subintentName! } : null,
        number: row.number,
      });
    }

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor({
            priority: lastRow.priority,
            createdAt: lastRow.createdAt.toISOString(),
            id: lastRow.id,
          })
        : null;

    if (extra.olderThanHours !== undefined) {
      const cutoff = Date.now() - extra.olderThanHours * 60 * 60 * 1000;
      return {
        conversations: summaries.filter(
          (s) => s.last_message_at !== null && new Date(s.last_message_at).getTime() < cutoff,
        ),
        nextCursor,
      };
    }
    return { conversations: summaries, nextCursor };
  });
}

const lastMessageAtExpr = sql<Date | null>`(select max(m.created_at) from ${message} m where m.conversation_id = ${conversation.id})`;
const tagCountExpr = sql<number>`(select count(*) from ${conversationTag} ct where ct.conversation_id = ${conversation.id} and ct.removed_at is null)`;

const SORT_COLUMNS: Record<SortKey, { expr: any; sqlType: string; nullsLast?: boolean }> = {
  player: { expr: player.externalId, sqlType: 'text' },
  status: { expr: conversation.status, sqlType: 'conversation_status' },
  priority: { expr: conversation.priority, sqlType: 'conversation_priority' },
  assignee: { expr: agent.displayName, sqlType: 'text', nullsLast: true },
  lastMessage: { expr: lastMessageAtExpr, sqlType: 'timestamptz', nullsLast: true },
  tags: { expr: tagCountExpr, sqlType: 'int' },
  created: { expr: conversation.createdAt, sqlType: 'timestamptz' },
  subintent: { expr: subintent.name, sqlType: 'text', nullsLast: true },
  number: { expr: conversation.number, sqlType: 'int' },
};

function orderExpr(key: SortKey, dir: 'asc' | 'desc') {
  const col = SORT_COLUMNS[key];
  const direction = dir === 'asc' ? sql`asc` : sql`desc`;
  const nulls = col.nullsLast ? sql`nulls last` : sql``;
  return sql`${col.expr} ${direction} ${nulls}`;
}

// Generalizes the old fixed priority-asc/activity-desc/id-desc three-branch
// OR (see git history) to any (primary, secondary, id) triple with
// independent per-key directions. id is always the final tiebreaker, always
// ascending, so the keyset stays total regardless of what's being sorted.
function buildAllCursorCondition(
  primaryKey: SortKey,
  primaryDir: 'asc' | 'desc',
  secondaryKey: SortKey,
  secondaryDir: 'asc' | 'desc',
  cursor: AllCursor,
) {
  const primary = SORT_COLUMNS[primaryKey];
  const secondary = SORT_COLUMNS[secondaryKey];
  const primaryOp = primaryDir === 'asc' ? sql`>` : sql`<`;
  const secondaryOp = secondaryDir === 'asc' ? sql`>` : sql`<`;
  return sql`(
    ${primary.expr} ${primaryOp} ${cursor.primary}::${sql.raw(primary.sqlType)}
    or (${primary.expr} = ${cursor.primary}::${sql.raw(primary.sqlType)} and ${secondary.expr} ${secondaryOp} ${cursor.secondary}::${sql.raw(secondary.sqlType)})
    or (${primary.expr} = ${cursor.primary}::${sql.raw(primary.sqlType)} and ${secondary.expr} = ${cursor.secondary}::${sql.raw(secondary.sqlType)} and ${conversation.id} > ${cursor.id}::uuid)
  )`;
}

async function listAllConversations(
  ctx: AgentContext,
  extra: ConversationsListFilters,
): Promise<ConversationsPage> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const statuses = extra.statuses?.length ? extra.statuses : ALL_QUEUE_STATUSES;
    const primaryKey: SortKey = extra.sortBy ?? 'priority';
    const primaryDir: 'asc' | 'desc' = extra.sortDir ?? 'asc';
    const secondaryKey: SortKey = extra.sortBy2 ?? 'created';
    const secondaryDir: 'asc' | 'desc' = extra.sortDir2 ?? 'asc';
    const cursor = extra.cursor ? decodeAllCursor(extra.cursor) : null;
    const cursorCondition = cursor
      ? buildAllCursorCondition(primaryKey, primaryDir, secondaryKey, secondaryDir, cursor)
      : undefined;

    const rows = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
        externalPlayerId: player.externalId,
        confirmPhase: conversation.confirmPhase,
        assignedAgentId: conversation.assignedAgentId,
        assignedAgentName: agent.displayName,
        priority: conversation.priority,
        createdAt: conversation.createdAt,
        subintentId: subintent.id,
        subintentName: subintent.name,
        number: conversation.number,
        primarySortValue: sql<string>`${SORT_COLUMNS[primaryKey].expr}::text`,
        secondarySortValue: sql<string>`${SORT_COLUMNS[secondaryKey].expr}::text`,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
      .where(
        and(
          or(...statuses.map((queue) => queueCondition(tx, queue))),
          cursorCondition,
          ...extraFilterConditions(extra),
        ),
      )
      .orderBy(
        orderExpr(primaryKey, primaryDir),
        orderExpr(secondaryKey, secondaryDir),
        conversation.id,
      )
      .limit(PAGE_SIZE + 1);

    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const summaries: AgentConversationSummary[] = [];
    for (const row of pageRows) {
      const [last] = await tx
        .select({ body: message.body, createdAt: message.createdAt })
        .from(message)
        .where(eq(message.conversationId, row.id))
        .orderBy(desc(message.seq))
        .limit(1);
      const tags = await getConversationTags(tx, row.id);

      summaries.push({
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
        created_at: row.createdAt.toISOString(),
        subintent: row.subintentId ? { id: row.subintentId, name: row.subintentName! } : null,
        number: row.number,
      });
    }

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeAllCursor({
            primary: lastRow.primarySortValue,
            secondary: lastRow.secondarySortValue,
            id: lastRow.id,
          })
        : null;

    return { conversations: summaries, nextCursor };
  });
}

async function listResolvedOrClosedConversations(
  ctx: AgentContext,
  filter: 'resolved' | 'closed',
  extra: ConversationsListFilters,
): Promise<ConversationsPage> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const timestampCol =
      filter === 'resolved' ? resolutionCycle.resolvedAt : resolutionCycle.closedAt;
    const timestampMs = sql`date_trunc('millisecond', ${timestampCol})`;
    const cursor = extra.cursor ? decodeTimelineCursor(extra.cursor) : null;
    const cursorCondition = cursor
      ? sql`(${timestampMs}, ${conversation.id}) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`
      : undefined;

    const rows = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
        externalPlayerId: player.externalId,
        confirmPhase: conversation.confirmPhase,
        assignedAgentId: conversation.assignedAgentId,
        assignedAgentName: agent.displayName,
        priority: conversation.priority,
        ts: timestampCol,
        createdAt: conversation.createdAt,
        subintentId: subintent.id,
        subintentName: subintent.name,
        number: conversation.number,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
      .innerJoin(
        resolutionCycle,
        and(
          eq(resolutionCycle.conversationId, conversation.id),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(latestCycle)
              .where(
                and(
                  eq(latestCycle.conversationId, resolutionCycle.conversationId),
                  sql`${latestCycle.cycleNo} > ${resolutionCycle.cycleNo}`,
                ),
              ),
          ),
        ),
      )
      .where(
        and(
          eq(conversation.status, filter),
          isNotNull(timestampCol),
          sql`${timestampCol} >= now() - interval '7 days'`,
          cursorCondition,
          ...extraFilterConditions(extra),
        ),
      )
      .orderBy(desc(timestampMs), desc(conversation.id))
      .limit(PAGE_SIZE + 1);

    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const summaries: AgentConversationSummary[] = [];
    for (const row of pageRows) {
      const [last] = await tx
        .select({ body: message.body, createdAt: message.createdAt })
        .from(message)
        .where(eq(message.conversationId, row.id))
        .orderBy(desc(message.seq))
        .limit(1);
      const tags = await getConversationTags(tx, row.id);

      summaries.push({
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
        created_at: row.createdAt.toISOString(),
        subintent: row.subintentId ? { id: row.subintentId, name: row.subintentName! } : null,
        number: row.number,
      });
    }

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow && lastRow.ts
        ? encodeTimelineCursor({ ts: lastRow.ts.toISOString(), id: lastRow.id })
        : null;

    return { conversations: summaries, nextCursor };
  });
}

export type ClaimResult = {
  claimed: boolean;
  status: string | null;
  posted: PostedMessageRow | null;
  notification: NotificationView | null;
};
export type TakeOverResult = ClaimResult;

async function postTakenOverNotice(
  tx: Tx,
  ctx: AgentContext,
  conversationId: string,
): Promise<PostedMessageRow> {
  const [actor] = await tx
    .select({ displayName: agent.displayName })
    .from(agent)
    .where(eq(agent.id, ctx.agentId))
    .limit(1);
  return postMessage(tx, {
    workspaceId: ctx.workspaceId,
    conversationId,
    authorType: 'system',
    actorId: null,
    body: `Chat taken over by ${actor?.displayName ?? 'an agent'}.`,
    visibility: 'internal',
  });
}

export async function claimConversation(
  ctx: AgentContext,
  conversationId: string,
): Promise<ClaimResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const claimed = await tx
      .update(conversation)
      .set({ assignedAgentId: ctx.agentId })
      .where(
        and(
          eq(conversation.id, conversationId),
          isNull(conversation.assignedAgentId),
          inArray(conversation.status, ACTIVE_AGENT_STATUSES),
        ),
      )
      .returning({ id: conversation.id, status: conversation.status });
    const [row] = claimed;
    if (!row) return { claimed: false, status: null, posted: null, notification: null };

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_assigned',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { agent_id: ctx.agentId, via: 'claim' },
    });
    const notification = await notifyAgent(tx, {
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      conversationId,
      via: 'claim',
    });
    const posted = await postTakenOverNotice(tx, ctx, conversationId);
    return { claimed: true, status: row.status, posted, notification };
  });
}

export async function takeOverConversation(
  ctx: AgentContext,
  conversationId: string,
): Promise<TakeOverResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .update(conversation)
      .set({ assignedAgentId: ctx.agentId, status: 'open', confirmPhase: 'none' })
      .where(
        and(
          eq(conversation.id, conversationId),
          isNull(conversation.assignedAgentId),
          eq(conversation.status, 'bot_active'),
        ),
      )
      .returning({ id: conversation.id, status: conversation.status });
    if (!row) return { claimed: false, status: null, posted: null, notification: null };

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_taken_over',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { agent_id: ctx.agentId, from_status: 'bot_active', to_status: 'open' },
    });
    const notification = await notifyAgent(tx, {
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      conversationId,
      via: 'take_over',
    });

    const posted = await postTakenOverNotice(tx, ctx, conversationId);
    return { claimed: true, status: row.status, posted, notification };
  });
}

export type ReassignResult =
  | { ok: true; status: string; posted: PostedMessageRow; notification: NotificationView }
  | { ok: false; reason: 'not_found' | 'invalid_status' | 'agent_not_found' | 'agent_not_active' };

async function postReassignedNotice(
  tx: Tx,
  ctx: AgentContext,
  conversationId: string,
  targetAgentId: string,
): Promise<PostedMessageRow> {
  const [actor] = await tx
    .select({ displayName: agent.displayName })
    .from(agent)
    .where(eq(agent.id, ctx.agentId))
    .limit(1);
  const [target] = await tx
    .select({ displayName: agent.displayName })
    .from(agent)
    .where(eq(agent.id, targetAgentId))
    .limit(1);
  return postMessage(tx, {
    workspaceId: ctx.workspaceId,
    conversationId,
    authorType: 'system',
    actorId: null,
    body: `Reassigned to ${target?.displayName ?? 'an agent'} by ${actor?.displayName ?? 'an agent'}.`,
    visibility: 'internal',
  });
}

export async function reassignConversation(
  ctx: AgentContext,
  conversationId: string,
  targetAgentId: string,
): Promise<ReassignResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [conv] = await tx
      .select({ id: conversation.id, status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1);
    if (!conv) return { ok: false, reason: 'not_found' };
    if (!ACTIVE_AGENT_STATUSES.includes(conv.status))
      return { ok: false, reason: 'invalid_status' };

    // A self-assign skips the workspace_member lookup: the actor is already
    // scoped into this workspace (JWT for a regular agent, X-Workspace-Id for
    // a global admin — see resolveConsoleWorkspace.ts), and a global admin
    // holds no workspace_member row anywhere by design, so the membership
    // check exists only to validate a *different* target picked off the
    // AssignPicker dropdown.
    if (targetAgentId !== ctx.agentId) {
      const [member] = await tx
        .select({ id: workspaceMember.id })
        .from(workspaceMember)
        .where(
          and(
            eq(workspaceMember.workspaceId, ctx.workspaceId),
            eq(workspaceMember.agentId, targetAgentId),
            isNull(workspaceMember.deactivatedAt),
          ),
        )
        .limit(1);
      if (!member) return { ok: false, reason: 'agent_not_found' };
    }

    const [targetAgent] = await tx
      .select({ status: agent.status })
      .from(agent)
      .where(eq(agent.id, targetAgentId))
      .limit(1);
    if (!targetAgent || targetAgent.status !== 'active')
      return { ok: false, reason: 'agent_not_active' };

    const [row] = await tx
      .update(conversation)
      .set({ assignedAgentId: targetAgentId })
      .where(eq(conversation.id, conversationId))
      .returning({ id: conversation.id, status: conversation.status });

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_reassigned',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { agent_id: targetAgentId, reassigned_by: ctx.agentId, via: 'reassign' },
    });
    const notification = await notifyAgent(tx, {
      workspaceId: ctx.workspaceId,
      agentId: targetAgentId,
      conversationId,
      via: 'reassign',
    });
    const posted = await postReassignedNotice(tx, ctx, conversationId, targetAgentId);
    return { ok: true, status: row!.status, posted, notification };
  });
}

export type UnassignResult =
  | { ok: true; status: string }
  | { ok: false; reason: 'not_found' | 'not_owner' | 'invalid_status' };

export async function unassignConversation(
  ctx: AgentContext,
  conversationId: string,
): Promise<UnassignResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [conv] = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
        assignedAgentId: conversation.assignedAgentId,
      })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1);
    if (!conv) return { ok: false, reason: 'not_found' };
    if (conv.status === 'resolved' || conv.status === 'closed')
      return { ok: false, reason: 'invalid_status' };
    // Also covers "already unassigned": assignedAgentId is null there, and
    // null !== ctx.agentId, so it falls into the same not-owned bucket.
    if (conv.assignedAgentId !== ctx.agentId) return { ok: false, reason: 'not_owner' };

    await tx
      .update(conversation)
      .set({ assignedAgentId: null })
      .where(eq(conversation.id, conversationId));

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_unassigned',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { previous_agent_id: ctx.agentId },
    });

    return { ok: true, status: conv.status };
  });
}

export type ReclassifyResult =
  | { ok: true; subintentId: string; status: string }
  | { ok: false; reason: 'not_found' | 'invalid_subintent' };

export async function reclassifyConversation(
  ctx: AgentContext,
  conversationId: string,
  subintentId: string,
): Promise<ReclassifyResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [conv] = await tx
      .select({
        id: conversation.id,
        subintentId: conversation.subintentId,
        status: conversation.status,
        priority: conversation.priority,
        priorityManuallySet: conversation.priorityManuallySet,
      })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1);
    if (!conv) return { ok: false, reason: 'not_found' };

    const [target] = await tx
      .select({ id: subintent.id })
      .from(subintent)
      .where(
        and(
          eq(subintent.id, subintentId),
          eq(subintent.workspaceId, ctx.workspaceId),
          isNull(subintent.archivedAt),
        ),
      )
      .limit(1);
    if (!target) return { ok: false, reason: 'invalid_subintent' };

    await tx
      .update(conversation)
      .set({ subintentId, classificationSource: 'agent' })
      .where(eq(conversation.id, conversationId));

    await applySubintentDefaultPriority(tx, {
      workspaceId: ctx.workspaceId,
      conversationId,
      subintentId,
      currentPriority: conv.priority,
      priorityManuallySet: conv.priorityManuallySet,
      actorId: ctx.agentId,
      actorType: 'agent',
    });

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_reclassified',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: {
        from_subintent_id: conv.subintentId,
        to_subintent_id: subintentId,
        classification_source: 'agent',
      },
    });
    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'conversation',
      entityId: conversationId,
      actorId: ctx.agentId,
      changes: [{ field: 'subintent_id', before: conv.subintentId, after: subintentId }],
    });
    return { ok: true, subintentId, status: conv.status };
  });
}

export type SetPriorityResult =
  { ok: true; updated: boolean; status: string } | { ok: false; reason: 'not_found' };

export async function setConversationPriority(
  ctx: AgentContext,
  conversationId: string,
  priority: (typeof conversation.priority.enumValues)[number],
): Promise<SetPriorityResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [conv] = await tx
      .select({ id: conversation.id, priority: conversation.priority, status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1);
    if (!conv) return { ok: false, reason: 'not_found' };
    if (conv.priority === priority) return { ok: true, updated: false, status: conv.status };

    await tx
      .update(conversation)
      .set({ priority, priorityManuallySet: true })
      .where(eq(conversation.id, conversationId));

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_priority_changed',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { from: conv.priority, to: priority, reason: 'manual' },
    });
    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'conversation',
      entityId: conversationId,
      actorId: ctx.agentId,
      changes: [{ field: 'priority', before: conv.priority, after: priority }],
    });
    return { ok: true, updated: true, status: conv.status };
  });
}

export type WorkspaceWorkloadAgent = {
  agentId: string;
  agentName: string;
  role: 'agent' | 'team_lead';
  openCount: number;
  capacityMax: number;
  escalatedCount: number;
  overdueCount: number;
  resolved7d: number;
  status: 'online' | 'away' | 'offline' | 'on_leave';
  onLeaveSince: Date | null;
  onLeaveUntil: Date | null;
};

export type WorkspaceWorkload = { agents: WorkspaceWorkloadAgent[] };

export async function getWorkspaceWorkload(ctx: AgentContext): Promise<WorkspaceWorkload> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [workspaceRow] = await tx
      .select({ maxAssignedTickets: workspace.maxAssignedTickets })
      .from(workspace)
      .where(eq(workspace.id, ctx.workspaceId));
    const capacityMax = workspaceRow?.maxAssignedTickets ?? 0;

    const openRows = await tx
      .select({
        agentId: conversation.assignedAgentId,
        count: sql<number>`count(*)`,
      })
      .from(conversation)
      .where(
        and(
          isNotNull(conversation.assignedAgentId),
          inArray(conversation.status, ACTIVE_AGENT_STATUSES),
        ),
      )
      .groupBy(conversation.assignedAgentId);

    const escalatedRows = await tx
      .select({
        agentId: conversation.assignedAgentId,
        count: sql<number>`count(*)`,
      })
      .from(conversation)
      .where(and(isNotNull(conversation.assignedAgentId), eq(conversation.status, 'escalated')))
      .groupBy(conversation.assignedAgentId);

    // One row per conversation: the message whose seq is the max seq for that
    // conversation. A correlated subquery on the same table, not a self-join,
    // because it must return exactly one row per conversation.
    const latestMessage = tx
      .select({
        conversationId: message.conversationId,
        authorType: message.authorType,
        createdAt: message.createdAt,
      })
      .from(message)
      .where(
        sql`${message.seq} = (select max(m2.seq) from message m2 where m2.conversation_id = ${message.conversationId})`,
      )
      .as('latest_message');

    // "Overdue" is deliberately not resolutionCycle.inactivityDueAt — that
    // clock resets on a message from either side, so it can't attribute
    // silence to the agent. This counts only conversations where the PLAYER's
    // latest message is the one still waiting on a reply, past 4 hours.
    const overdueRows = await tx
      .select({
        agentId: conversation.assignedAgentId,
        count: sql<number>`count(*)`,
      })
      .from(conversation)
      .innerJoin(latestMessage, eq(latestMessage.conversationId, conversation.id))
      .where(
        and(
          isNotNull(conversation.assignedAgentId),
          inArray(conversation.status, ACTIVE_AGENT_STATUSES),
          eq(latestMessage.authorType, 'player'),
          sql`${latestMessage.createdAt} < now() - interval '4 hours'`,
        ),
      )
      .groupBy(conversation.assignedAgentId);

    const resolvedRows = await tx
      .select({
        agentId: conversation.assignedAgentId,
        count: sql<number>`count(*)`,
      })
      .from(resolutionCycle)
      .innerJoin(conversation, eq(conversation.id, resolutionCycle.conversationId))
      .where(
        and(
          sql`${resolutionCycle.resolvedAt} >= now() - interval '7 days'`,
          isNotNull(conversation.assignedAgentId),
        ),
      )
      .groupBy(conversation.assignedAgentId);

    const roster = await tx
      .select({
        agentId: workspaceMember.agentId,
        role: workspaceMember.role,
        agentName: agent.displayName,
        agentStatus: agent.status,
        onLeaveSince: agent.onLeaveSince,
        onLeaveUntil: agent.onLeaveUntil,
      })
      .from(workspaceMember)
      .innerJoin(agent, eq(agent.id, workspaceMember.agentId))
      .where(
        and(
          eq(workspaceMember.workspaceId, ctx.workspaceId),
          inArray(workspaceMember.role, ['agent', 'team_lead']),
          isNull(workspaceMember.deactivatedAt),
        ),
      );

    const openByAgent = new Map(openRows.map((r) => [r.agentId as string, Number(r.count)]));
    const escalatedByAgent = new Map(
      escalatedRows.map((r) => [r.agentId as string, Number(r.count)]),
    );
    const overdueByAgent = new Map(overdueRows.map((r) => [r.agentId as string, Number(r.count)]));
    const resolvedByAgent = new Map(
      resolvedRows.map((r) => [r.agentId as string, Number(r.count)]),
    );

    let presenceByAgent: Map<string, 'online' | 'away' | 'offline'>;
    try {
      presenceByAgent = await getPresenceStatusBatch(roster.map((member) => member.agentId));
    } catch (error) {
      // Presence is a display nicety on this page, not load-bearing: the
      // open/resolved counts must still render even if Redis is unreachable.
      // Every row falls back to offline rather than failing the whole request.
      logger.error(
        'workload',
        `presence batch read failed, falling back to offline: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      presenceByAgent = new Map();
    }

    const agents: WorkspaceWorkloadAgent[] = roster.map((member) => ({
      agentId: member.agentId,
      agentName: member.agentName,
      role: member.role,
      openCount: openByAgent.get(member.agentId) ?? 0,
      capacityMax,
      escalatedCount: escalatedByAgent.get(member.agentId) ?? 0,
      overdueCount: overdueByAgent.get(member.agentId) ?? 0,
      resolved7d: resolvedByAgent.get(member.agentId) ?? 0,
      // on_leave (account-level, admin-managed) overrides live presence
      // unconditionally; otherwise fall through to Redis presence, defaulting
      // to offline when absent (including on a Redis-read failure above).
      status:
        member.agentStatus === 'on_leave'
          ? 'on_leave'
          : (presenceByAgent.get(member.agentId) ?? 'offline'),
      onLeaveSince: member.agentStatus === 'on_leave' ? member.onLeaveSince : null,
      onLeaveUntil: member.agentStatus === 'on_leave' ? member.onLeaveUntil : null,
    }));

    return { agents };
  });
}

export async function getAgentConversationMessages(
  ctx: AgentContext,
  conversationId: string,
): Promise<AgentMessageView[] | null> {
  const rows = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1);
    if (!found) return null;

    return tx
      .select({
        id: message.id,
        conversationId: message.conversationId,
        seq: message.seq,
        authorType: message.authorType,
        authorAgentId: message.authorAgentId,
        body: message.body,
        articleId: message.articleId,
        visibility: message.visibility,
        deliveryState: message.deliveryState,
        readAt: message.readAt,
        createdAt: message.createdAt,
        authorAgentName: agent.displayName,
        authorPlayerName: player.externalId,
        attachmentId: attachment.id,
        attachmentStorageKey: attachment.storageKey,
        attachmentFilename: attachment.filename,
        attachmentMimeType: attachment.mimeType,
        attachmentByteSize: attachment.byteSize,
      })
      .from(message)
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(agent, eq(agent.id, message.authorAgentId))
      .leftJoin(attachment, eq(attachment.messageId, message.id))
      .where(eq(message.conversationId, conversationId))
      .orderBy(message.seq);
  });

  if (rows === null) return null;

  // storageKey is looked up from `rows` by message id rather than carried on
  // `view` itself, because AgentMessageView's `attachment` shape (Task 4 Step
  // 1) has no storageKey field on the wire — it is signing-internal, never
  // sent to a client.
  const storageKeyByMessageId = new Map(
    rows.filter((r) => r.attachmentStorageKey).map((r) => [r.id, r.attachmentStorageKey!]),
  );
  const views = rows.map((row) => toAgentView(row));

  return Promise.all(
    views.map(async (view) => {
      if (!view.attachment) return view;
      const storageKey = storageKeyByMessageId.get(view.id);
      if (!storageKey) return view;
      try {
        const url = await presignGetObject(storageKey);
        return { ...view, attachment: { ...view.attachment, url } };
      } catch {
        // Signing failed for an existing attachment row — omit the URL rather
        // than throwing, per the design doc: a broken attachment must not break
        // loading the rest of the thread.
        return view;
      }
    }),
  );
}
