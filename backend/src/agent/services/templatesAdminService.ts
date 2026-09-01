import { and, asc, eq } from 'drizzle-orm';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { messageTemplate } from '../../shared/db/schema/index.ts';
import {
  addHandoffVariant,
  createCannedReply,
  createSystemTemplate,
  getSystemMessage,
  loadTemplates,
  updateTemplate,
  type SystemMessageKey,
  type TemplateRowView,
} from '../../domain/templates/templateService.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

const SINGLETON_SYSTEM_KEYS = [
  'no_agents_online',
  'form_summary_completed',
  'form_summary_partial',
  'form_summary_skipped',
] as const;

export type TemplatesAdminView = {
  system: Record<SystemMessageKey, { id: string | null; body: string } | { id: string; body: string }[]>;
  canned: { id: string; label: string; body: string }[];
};

/**
 * Admin-facing view: singleton keys resolve to one {id, body} pair (id: null
 * means "still on the default, no row exists yet — POST to create the first
 * one"); handoff resolves to an array of real rows only (an admin adds a
 * first custom variant with POST rather than editing a synthetic default).
 *
 * loadTemplates() (Task 3) only returns bodies, shaped for the Redis cache —
 * the admin view additionally needs each row's real id to PATCH, so this
 * re-selects the raw rows directly rather than widening the cache payload's
 * shape for every hot-path reader just to serve this one admin screen.
 */
export async function getTemplatesForAdmin(ctx: AgentContext): Promise<TemplatesAdminView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const { canned } = await loadTemplates(tx, ctx.workspaceId);
    const [noAgentsOnline, formSummaryCompleted, formSummaryPartial, formSummarySkipped] =
      await Promise.all([
        getSystemMessage(tx, ctx.workspaceId, 'no_agents_online'),
        getSystemMessage(tx, ctx.workspaceId, 'form_summary_completed'),
        getSystemMessage(tx, ctx.workspaceId, 'form_summary_partial'),
        getSystemMessage(tx, ctx.workspaceId, 'form_summary_skipped'),
      ]);
    const dbRows = await tx
      .select()
      .from(messageTemplate)
      .where(
        and(eq(messageTemplate.workspaceId, ctx.workspaceId), eq(messageTemplate.isActive, true)),
      )
      .orderBy(asc(messageTemplate.sortOrder));

    const view: TemplatesAdminView = {
      system: {
        no_agents_online: { id: null, body: noAgentsOnline },
        form_summary_completed: { id: null, body: formSummaryCompleted },
        form_summary_partial: { id: null, body: formSummaryPartial },
        form_summary_skipped: { id: null, body: formSummarySkipped },
        handoff: [],
      },
      canned,
    };
    for (const row of dbRows) {
      if (row.kind === 'system' && row.key && SINGLETON_SYSTEM_KEYS.includes(row.key as any)) {
        view.system[row.key as SystemMessageKey] = { id: row.id, body: row.body };
      } else if (row.kind === 'system' && row.key === 'handoff') {
        (view.system.handoff as { id: string; body: string }[]).push({
          id: row.id,
          body: row.body,
        });
      }
    }
    return view;
  });
}

export async function createTemplate(
  ctx: AgentContext,
  args:
    | { kind: 'system'; key: (typeof SINGLETON_SYSTEM_KEYS)[number]; body: string }
    | { kind: 'system'; key: 'handoff'; body: string }
    | { kind: 'canned'; label: string; body: string },
): Promise<TemplateRowView> {
  if (args.kind === 'canned') return createCannedReply(ctx, { label: args.label, body: args.body });
  if (args.key === 'handoff') return addHandoffVariant(ctx, args.body);
  return createSystemTemplate(ctx, { key: args.key, body: args.body });
}

export { updateTemplate as updateTemplateForAdmin, SINGLETON_SYSTEM_KEYS };
