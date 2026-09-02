import { and, asc, count, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type {
  AgentConversationContextResponse,
  AgentConversationDetail,
  AgentFormFieldView,
  AgentFormView,
  AgentPlayerStateView,
  AgentTicketSummary,
  FormField,
  FormFieldType,
} from '@support/types';
import {
  agent,
  attachment,
  conversation,
  declaredField,
  event,
  form,
  formAnswer,
  formSubmission,
  formVersion,
  intent,
  player,
  playerStateSnapshot,
  resolutionCycle,
  subintent,
  workspace,
} from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import { presignGetObject } from '../../shared/storage/presign.ts';
import { getConversationTags } from './tagsService.ts';

/**
 * One conversation's header row, by id.
 *
 * `null` covers both "no such conversation" and "not this workspace" — RLS
 * makes the two indistinguishable, which is the point. The controller turns it
 * into a 404 either way.
 */
export async function getConversationDetail(
  ctx: AgentContext,
  conversationId: string,
): Promise<AgentConversationDetail | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .select({
        id: conversation.id,
        number: conversation.number,
        status: conversation.status,
        priority: conversation.priority,
        resolutionSource: conversation.resolutionSource,
        createdAt: conversation.createdAt,
        playerId: player.id,
        externalPlayerId: player.externalId,
        intentName: intent.name,
        subintentName: subintent.name,
        subintentId: subintent.id,
        assignedAgentId: agent.id,
        assignedAgentName: agent.displayName,
        resolvedAt: resolutionCycle.resolvedAt,
        autoCloseDays: workspace.autoCloseDays,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
      .leftJoin(intent, eq(intent.id, subintent.intentId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .innerJoin(workspace, eq(workspace.id, conversation.workspaceId))
      // At most one open cycle exists (resolution_cycle_open_uk), and once
      // resolved it stays resolved — ordering by resolvedAt desc + limit 1
      // on the outer query picks the most recent closed cycle regardless of
      // how many past cycles a reopened conversation has.
      .leftJoin(
        resolutionCycle,
        and(eq(resolutionCycle.conversationId, conversation.id), isNotNull(resolutionCycle.resolvedAt)),
      )
      .where(eq(conversation.id, conversationId))
      .orderBy(desc(resolutionCycle.resolvedAt))
      .limit(1);

    if (!row) return null;

    return {
      id: row.id,
      number: row.number,
      player: { id: row.playerId, external_player_id: row.externalPlayerId },
      status: row.status,
      priority: row.priority,
      subintent:
        row.subintentName && row.intentName
          ? {
              intent_name: row.intentName,
              subintent_name: row.subintentName,
              subintent_id: row.subintentId,
            }
          : null,
      assigned_agent:
        row.assignedAgentId && row.assignedAgentName
          ? { id: row.assignedAgentId, display_name: row.assignedAgentName }
          : null,
      resolution_source: row.resolutionSource,
      resolved_by_agent_name:
        row.resolutionSource === 'agent' || row.resolutionSource === 'admin_forced'
          ? row.assignedAgentName
          : null,
      resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      auto_close_days: row.autoCloseDays,
      created_at: row.createdAt.toISOString(),
    };
  });
}

/**
 * The rail's player-state panel, as a tagged union rather than one nullable
 * object. Four cases, all 200: missing player state is a state, not an error.
 *
 * No fallback to a later snapshot. When this conversation's session captured
 * nothing, the response says so and carries nothing else — synthesising state
 * from a different session would manufacture exactly the misleading
 * current-level number the product spec rejects, and a label under a number
 * does not stop anyone reading the number.
 *
 * Takes an open tx so the context endpoint reads everything in one transaction.
 */
export async function getPlayerStateView(
  tx: Tx,
  workspaceId: string,
  sessionId: string | null,
): Promise<AgentPlayerStateView> {
  if (!sessionId) return { status: 'no_session' };

  const [snapshot] = await tx
    .select({
      declared: playerStateSnapshot.declared,
      raw: playerStateSnapshot.raw,
      isMissing: playerStateSnapshot.isMissing,
      degradedReason: playerStateSnapshot.degradedReason,
      capturedAt: playerStateSnapshot.capturedAt,
    })
    .from(playerStateSnapshot)
    .where(eq(playerStateSnapshot.sessionId, sessionId))
    .limit(1);

  if (!snapshot) return { status: 'not_captured' };
  if (snapshot.isMissing) return { status: 'missing' };

  // Ordered by when the field was declared, so the seed order the game sees in
  // its own config is the order the agent reads down the panel.
  const fields = await tx
    .select({ key: declaredField.key, label: declaredField.label, type: declaredField.type })
    .from(declaredField)
    .where(eq(declaredField.workspaceId, workspaceId))
    .orderBy(asc(declaredField.declaredAt), asc(declaredField.key));

  const blob = snapshot.declared;
  const declared: {
    key: string;
    label: string;
    type: (typeof fields)[number]['type'];
    value: unknown;
  }[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (!(field.key in blob)) continue;
    seen.add(field.key);
    declared.push({ key: field.key, label: field.label, type: field.type, value: blob[field.key] });
  }
  // A key in the blob with no declared_field row cannot normally occur —
  // nothing is ever deleted — but appending beats dropping: a value the agent
  // can see is worth more than a tidy list.
  for (const key of Object.keys(blob)) {
    if (seen.has(key)) continue;
    declared.push({ key, label: key, type: 'string', value: blob[key] });
  }

  return {
    status: 'captured',
    declared,
    raw: snapshot.raw,
    degraded_reason: snapshot.degradedReason,
    captured_at: snapshot.capturedAt.toISOString(),
  };
}

const TICKET_CAP = 20;

export type TicketHistory = {
  tickets: AgentTicketSummary[];
  totalTickets: number;
  totalReopened: number;
};

/**
 * This player's conversations in this workspace, newest first, including the
 * current one — the rail highlights it in place rather than dropping the row
 * the agent just clicked. Capped at 20 rows total, which now includes the
 * current row, with the earlier-ticket count alongside.
 *
 * Two queries regardless of ticket count. listConversations() runs one preview
 * query per row and says so in a comment; this does not repeat that. The total
 * rides along on the first query as a window count — Postgres computes window
 * functions before LIMIT, so it counts the whole population, not the page.
 *
 * The message table is never touched, so there is no path by which an internal
 * note reaches this response. toAgentView is not involved.
 */
export async function getTicketHistory(
  tx: Tx,
  args: { playerId: string; currentConversationId: string },
): Promise<TicketHistory> {
  const rows = await tx
    .select({
      id: conversation.id,
      number: conversation.number,
      createdAt: conversation.createdAt,
      status: conversation.status,
      resolutionSource: conversation.resolutionSource,
      intentName: intent.name,
      subintentName: subintent.name,
      subintentId: subintent.id,
      assignedAgentName: agent.displayName,
      totalCount: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(conversation)
    .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
    .leftJoin(intent, eq(intent.id, subintent.intentId))
    .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
    .where(eq(conversation.playerId, args.playerId))
    .orderBy(desc(conversation.createdAt))
    .limit(TICKET_CAP);

  const reopens = await tx
    .select({ conversationId: event.conversationId, reopens: count() })
    .from(event)
    .innerJoin(conversation, eq(conversation.id, event.conversationId))
    .where(and(eq(event.type, 'conversation_reopened'), eq(conversation.playerId, args.playerId)))
    .groupBy(event.conversationId);

  const reopenById = new Map<string, number>();
  let totalReopened = 0;
  for (const row of reopens) {
    if (!row.conversationId) continue;
    reopenById.set(row.conversationId, row.reopens);
    // Per-row counts cover the current ticket too, so its own reopens show; the
    // summary total stays on the earlier tickets only, matching total_tickets.
    if (row.conversationId !== args.currentConversationId) totalReopened += row.reopens;
  }

  const tickets: AgentTicketSummary[] = rows.map((row) => ({
    id: row.id,
    number: row.number,
    created_at: row.createdAt.toISOString(),
    status: row.status,
    subintent:
      row.subintentName && row.intentName
        ? {
            intent_name: row.intentName,
            subintent_name: row.subintentName,
            subintent_id: row.subintentId,
          }
        : null,
    resolution_source: row.resolutionSource,
    resolved_by_agent_name:
      row.resolutionSource === 'agent' || row.resolutionSource === 'admin_forced'
        ? row.assignedAgentName
        : null,
    reopen_count: reopenById.get(row.id) ?? 0,
  }));

  // total_tickets still means "earlier tickets": the current one is always in
  // the window count now, so subtract it.
  const totalTickets = Math.max(0, (rows[0]?.totalCount ?? 0) - 1);

  return { tickets, totalTickets, totalReopened };
}

/**
 * The whole rail in one payload. One endpoint rather than two, because the rail
 * is one thing, always fetched together, and its two halves have the same cache
 * lifetime.
 *
 * `null` is not found or not this workspace — RLS makes those indistinguishable
 * and the controller returns 404 for both.
 */
export async function getConversationContext(
  ctx: AgentContext,
  conversationId: string,
): Promise<AgentConversationContextResponse | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({
        sessionId: conversation.sessionId,
        playerId: player.id,
        firstSeenAt: player.firstSeenAt,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .where(eq(conversation.id, conversationId))
      .limit(1);

    if (!current) return null;

    const playerState = await getPlayerStateView(tx, ctx.workspaceId, current.sessionId);
    const history = await getTicketHistory(tx, {
      playerId: current.playerId,
      currentConversationId: conversationId,
    });
    const formView = await getFormView(tx, conversationId);
    const tags = await getConversationTags(tx, conversationId);

    return {
      player_state: playerState,
      tickets: history.tickets,
      summary: {
        total_tickets: history.totalTickets,
        total_reopened: history.totalReopened,
        first_contact_at: current.firstSeenAt.toISOString(),
      },
      form: formView,
      tags,
    };
  });
}

/** One field's current answer: the row with the greatest `created_at` for its key. */
export type LatestAnswer = { fieldKey: string; fieldType: FormFieldType; value: unknown };

/**
 * The submission's snapshotted field list folded together with its current
 * answers. Pure, and exported so the behaviour that carries the product
 * requirement is testable without a database.
 *
 * Labels come from the version the player was actually asked. Types come from
 * the answers themselves. Unanswered fields stay in the list as rows — dropping
 * them would make a partial form indistinguishable from a shorter one.
 */
export function buildFormFieldViews(
  fields: FormField[],
  answers: LatestAnswer[],
): { rows: AgentFormFieldView[]; answeredCount: number } {
  const byKey = new Map(answers.map((answer) => [answer.fieldKey, answer]));
  const rows: AgentFormFieldView[] = [];
  let answeredCount = 0;

  // Sorted here rather than trusted from the jsonb array: this list is read as
  // the order the questions were asked in, and a mis-ordered row misreads.
  const ordered = [...fields].sort((a, b) => a.position - b.position);
  for (const field of ordered) {
    const answer = byKey.get(field.key);
    if (answer) answeredCount += 1;
    rows.push({
      key: field.key,
      label: field.label,
      position: field.position,
      field_type: answer ? answer.fieldType : field.type,
      value: answer ? answer.value : null,
      answered: answer !== undefined,
    });
  }

  // An answer whose key is not in the version cannot normally occur — the answer
  // route validates against this same version — but appending beats dropping,
  // the same call getPlayerStateView makes for an undeclared blob key. It does
  // not count toward answered_count: the denominator is the questions asked.
  const known = new Set(ordered.map((field) => field.key));
  for (const answer of answers) {
    if (known.has(answer.fieldKey)) continue;
    rows.push({
      key: answer.fieldKey,
      label: answer.fieldKey,
      position: rows.length,
      field_type: answer.fieldType,
      value: answer.value,
      answered: true,
    });
  }

  return { rows, answeredCount };
}

/**
 * `buildFormFieldViews` stays pure and DB-free for testability; this is the one
 * place an `attachment`-type answer's `{ attachmentId }` gets turned into
 * something the rail can render a preview from. A failed signing attempt or a
 * missing row (the attachment predates the row somehow, or RLS hides it) just
 * leaves that field's value alone rather than failing the whole rail — an
 * un-previewable answer is still an answer.
 */
async function resolveAttachmentFieldValues(
  tx: Tx,
  rows: AgentFormFieldView[],
): Promise<AgentFormFieldView[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (row.field_type !== 'attachment' || !row.answered) return row;
      const attachmentId = (row.value as { attachmentId?: string } | null)?.attachmentId;
      if (!attachmentId) return row;

      const [source] = await tx
        .select({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          byteSize: attachment.byteSize,
          storageKey: attachment.storageKey,
        })
        .from(attachment)
        .where(eq(attachment.id, attachmentId))
        .limit(1);
      if (!source) return row;

      try {
        const url = await presignGetObject(source.storageKey);
        return {
          ...row,
          value: {
            attachmentId,
            filename: source.filename,
            mimeType: source.mimeType,
            byteSize: source.byteSize,
            url,
          },
        };
      } catch {
        return row;
      }
    }),
  );
}

/**
 * The rail's form section, or null when this conversation was never offered a
 * form — the common case, and not an error. The frontend omits the section
 * entirely rather than opening onto nothing.
 *
 * Three reads, all inside the caller's transaction so the whole rail is one
 * consistent snapshot:
 *
 * 1. the submission, joined to `form` for its name
 * 2. the version the submission snapshotted — never the current one, which is
 *    the entire reason form_submission.form_version exists
 * 3. every answer row, folded to the greatest created_at per field_key
 *
 * The answers are folded in JS rather than with DISTINCT ON: a submission holds
 * one row per field plus corrections, so this is a handful of rows, and it keeps
 * the read inside the typed query builder.
 */
export async function getFormView(tx: Tx, conversationId: string): Promise<AgentFormView | null> {
  const [submission] = await tx
    .select({
      id: formSubmission.id,
      formId: formSubmission.formId,
      version: formSubmission.formVersion,
      status: formSubmission.status,
      formName: form.name,
    })
    .from(formSubmission)
    .innerJoin(form, eq(form.id, formSubmission.formId))
    .where(eq(formSubmission.conversationId, conversationId))
    // UNIQUE (conversation_id, form_id) and "offered once per conversation" mean
    // there is at most one today. Newest-first with limit 1 so a future second
    // form shows the current one rather than an arbitrary row.
    .orderBy(desc(formSubmission.startedAt))
    .limit(1);

  if (!submission) return null;

  const [version] = await tx
    .select({ fields: formVersion.fields })
    .from(formVersion)
    .where(
      and(eq(formVersion.formId, submission.formId), eq(formVersion.version, submission.version)),
    )
    .limit(1);

  // FK (form_id, form_version) -> form_version (form_id, version) makes the
  // miss impossible; an empty list beats a throw if the constraint ever slips.
  const fields = version?.fields ?? [];

  const answerRows = await tx
    .select({
      fieldKey: formAnswer.fieldKey,
      fieldType: formAnswer.fieldType,
      value: formAnswer.value,
    })
    .from(formAnswer)
    .where(eq(formAnswer.formSubmissionId, submission.id))
    .orderBy(asc(formAnswer.createdAt), asc(formAnswer.id));

  // Oldest first, so the last write for a key wins — which is the read rule:
  // the current answer is the row with the greatest created_at. Older rows stay
  // queryable; revision history in a rail nobody asked for is noise.
  const latest = new Map<string, LatestAnswer>();
  for (const row of answerRows) latest.set(row.fieldKey, row);

  const { rows, answeredCount } = buildFormFieldViews(fields, [...latest.values()]);
  const resolvedRows = await resolveAttachmentFieldValues(tx, rows);

  return {
    form_name: submission.formName,
    form_version: submission.version,
    status: submission.status,
    field_count: fields.length,
    answered_count: answeredCount,
    fields: resolvedRows,
  };
}
