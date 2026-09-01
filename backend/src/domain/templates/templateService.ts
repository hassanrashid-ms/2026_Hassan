import { and, asc, eq } from 'drizzle-orm';
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts';
import { messageTemplate } from '../../shared/db/schema/index.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import {
  getCachedTemplates,
  invalidateCachedTemplates,
  setCachedTemplates,
  type CannedReplyEntry,
  type SystemMessageKey,
  type TemplatesCachePayload,
} from './templateCache.ts';
import { HANDOFF_PLAYER_MESSAGES, NO_AGENTS_ONLINE_MESSAGE } from '../bot/messages.ts';
import { FORM_SUMMARY_MESSAGES } from '../forms/messages.ts';

export type { CannedReplyEntry, SystemMessageKey } from './templateCache.ts';

/**
 * The pre-feature behaviour, keyed the same way system rows are — read only
 * by loadTemplates() below when a workspace has zero active rows for a key.
 * Mirrors resolveBotConfig's "genuinely absent row collapses to the catalog
 * baseline" pattern: nothing is seeded or backfilled, so every workspace that
 * predates this feature (and every test that seeds a workspace via raw SQL,
 * bypassing any app-level provisioning) keeps behaving exactly as before.
 */
export const DEFAULT_SYSTEM_MESSAGES: Record<SystemMessageKey, string[]> = {
  no_agents_online: [NO_AGENTS_ONLINE_MESSAGE],
  handoff: [...HANDOFF_PLAYER_MESSAGES],
  form_summary_completed: [FORM_SUMMARY_MESSAGES.completed],
  form_summary_partial: [FORM_SUMMARY_MESSAGES.partial],
  form_summary_skipped: [FORM_SUMMARY_MESSAGES.skipped],
};

/**
 * Cache-aside read of a workspace's full active template set. Takes the
 * caller's own transaction rather than opening one itself — every call site
 * (applyBotTurn, completeFormAndHandoff, messagesService's reopen branch)
 * already owns a single transaction for the whole request, per this repo's
 * "one transaction per call" convention, and nesting a second withWorkspace
 * here would open a second connection with its own RLS setting for no reason.
 */
export async function loadTemplates(tx: Tx, workspaceId: string): Promise<TemplatesCachePayload> {
  const cached = await getCachedTemplates(workspaceId);
  if (cached) return cached;

  const rows = await tx
    .select({
      kind: messageTemplate.kind,
      key: messageTemplate.key,
      id: messageTemplate.id,
      label: messageTemplate.label,
      body: messageTemplate.body,
    })
    .from(messageTemplate)
    .where(and(eq(messageTemplate.workspaceId, workspaceId), eq(messageTemplate.isActive, true)))
    .orderBy(asc(messageTemplate.sortOrder));

  const system: Record<SystemMessageKey, string[]> = {
    no_agents_online: [],
    handoff: [],
    form_summary_completed: [],
    form_summary_partial: [],
    form_summary_skipped: [],
  };
  const canned: CannedReplyEntry[] = [];

  for (const row of rows) {
    if (row.kind === 'system' && row.key) {
      system[row.key as SystemMessageKey].push(row.body);
    } else if (row.kind === 'canned') {
      canned.push({ id: row.id, label: row.label ?? '', body: row.body });
    }
  }

  const payload: TemplatesCachePayload = { system, canned };
  await setCachedTemplates(workspaceId, payload);
  return payload;
}

/**
 * Every system key supports N variants, picked at random per call — same
 * reasoning as the pre-feature pickHandoffMessage() in bot/messages.ts, now
 * over a workspace-configurable list instead of a hardcoded one, and applied
 * uniformly rather than singled out for 'handoff'. Callers must not cache the
 * result across messages.
 */
export async function getSystemMessage(
  tx: Tx,
  workspaceId: string,
  key: SystemMessageKey,
): Promise<string> {
  const { system } = await loadTemplates(tx, workspaceId);
  const variants = system[key].length > 0 ? system[key] : DEFAULT_SYSTEM_MESSAGES[key];
  return variants[Math.floor(Math.random() * variants.length)]!;
}

/** Thin alias kept for call-site clarity at the handoff sites. */
export async function getHandoffMessage(tx: Tx, workspaceId: string): Promise<string> {
  return getSystemMessage(tx, workspaceId, 'handoff');
}

export async function listCannedReplies(tx: Tx, workspaceId: string): Promise<CannedReplyEntry[]> {
  const { canned } = await loadTemplates(tx, workspaceId);
  return canned;
}

export type TemplateRowView = {
  id: string;
  kind: 'system' | 'canned';
  key: string | null;
  label: string | null;
  body: string;
  sort_order: number;
  is_active: boolean;
};

function toView(row: typeof messageTemplate.$inferSelect): TemplateRowView {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    label: row.label,
    body: row.body,
    sort_order: row.sortOrder,
    is_active: row.isActive,
  };
}

/**
 * Every system key (not just 'handoff') supports N variants: a new row is
 * appended rather than replacing the prior active one, matching
 * getSystemMessage's random-pick-among-active-rows read path.
 */
export async function addSystemVariant(
  ctx: Pick<AgentContext, 'agentId' | 'workspaceId'>,
  key: SystemMessageKey,
  body: string,
): Promise<TemplateRowView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [maxRow] = await tx
      .select({ sortOrder: messageTemplate.sortOrder })
      .from(messageTemplate)
      .where(
        and(
          eq(messageTemplate.workspaceId, ctx.workspaceId),
          eq(messageTemplate.kind, 'system'),
          eq(messageTemplate.key, key),
        ),
      )
      .orderBy(asc(messageTemplate.sortOrder))
      .limit(1);
    const [created] = await tx
      .insert(messageTemplate)
      .values({
        workspaceId: ctx.workspaceId,
        kind: 'system',
        key,
        body,
        sortOrder: (maxRow?.sortOrder ?? -1) + 1,
        createdByAgentId: ctx.agentId,
      })
      .returning();
    await invalidateCachedTemplates(ctx.workspaceId);
    return toView(created!);
  });
}

export async function createCannedReply(
  ctx: Pick<AgentContext, 'agentId' | 'workspaceId'>,
  args: { label: string; body: string },
): Promise<TemplateRowView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [maxRow] = await tx
      .select({ sortOrder: messageTemplate.sortOrder })
      .from(messageTemplate)
      .where(
        and(eq(messageTemplate.workspaceId, ctx.workspaceId), eq(messageTemplate.kind, 'canned')),
      )
      .orderBy(asc(messageTemplate.sortOrder))
      .limit(1);
    const [created] = await tx
      .insert(messageTemplate)
      .values({
        workspaceId: ctx.workspaceId,
        kind: 'canned',
        label: args.label,
        body: args.body,
        sortOrder: (maxRow?.sortOrder ?? -1) + 1,
        createdByAgentId: ctx.agentId,
      })
      .returning();
    await invalidateCachedTemplates(ctx.workspaceId);
    return toView(created!);
  });
}

export async function updateTemplate(
  ctx: Pick<AgentContext, 'workspaceId'>,
  id: string,
  patch: { body?: string; label?: string; isActive?: boolean },
): Promise<TemplateRowView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [updated] = await tx
      .update(messageTemplate)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(messageTemplate.id, id), eq(messageTemplate.workspaceId, ctx.workspaceId)))
      .returning();
    if (!updated) throw new Error('Template not found in this workspace');
    await invalidateCachedTemplates(ctx.workspaceId);
    return toView(updated);
  });
}
