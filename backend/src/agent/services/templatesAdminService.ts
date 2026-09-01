import { and, asc, eq } from 'drizzle-orm';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { messageTemplate } from '../../shared/db/schema/index.ts';
import {
  addSystemVariant,
  createCannedReply,
  DEFAULT_SYSTEM_MESSAGES,
  loadTemplates,
  updateTemplate,
  type SystemMessageKey,
  type TemplateRowView,
} from '../../domain/templates/templateService.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

export const SYSTEM_MESSAGE_KEYS = [
  'no_agents_online',
  'handoff',
  'form_summary_completed',
  'form_summary_partial',
  'form_summary_skipped',
] as const satisfies readonly SystemMessageKey[];

export type TemplatesAdminView = {
  system: Record<SystemMessageKey, { id: string | null; body: string }[]>;
  canned: { id: string; label: string; body: string }[];
};

/**
 * Admin-facing view: every system key resolves to an array of variants
 * (id: null entries are the built-in defaults still in effect — nothing
 * to PATCH yet, POST to create the first real row). loadTemplates() (Task 3)
 * only returns bodies, shaped for the Redis cache — the admin view
 * additionally needs each row's real id to PATCH, so this re-selects the raw
 * rows directly rather than widening the cache payload's shape for every
 * hot-path reader just to serve this one admin screen.
 */
export async function getTemplatesForAdmin(ctx: AgentContext): Promise<TemplatesAdminView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const { canned } = await loadTemplates(tx, ctx.workspaceId);
    const dbRows = await tx
      .select()
      .from(messageTemplate)
      .where(
        and(eq(messageTemplate.workspaceId, ctx.workspaceId), eq(messageTemplate.isActive, true)),
      )
      .orderBy(asc(messageTemplate.sortOrder));

    const system: Record<SystemMessageKey, { id: string | null; body: string }[]> = {
      no_agents_online: [],
      handoff: [],
      form_summary_completed: [],
      form_summary_partial: [],
      form_summary_skipped: [],
    };
    for (const row of dbRows) {
      if (row.kind === 'system' && row.key) {
        system[row.key as SystemMessageKey].push({ id: row.id, body: row.body });
      }
    }
    // No custom variants yet for a key — show its built-in defaults (id: null)
    // so the admin sees what's actually live today, rather than an empty list
    // implying nothing is configured.
    for (const key of SYSTEM_MESSAGE_KEYS) {
      if (system[key].length === 0) {
        system[key] = DEFAULT_SYSTEM_MESSAGES[key].map((body) => ({ id: null, body }));
      }
    }

    return { system, canned };
  });
}

export async function createTemplate(
  ctx: AgentContext,
  args:
    | { kind: 'system'; key: SystemMessageKey; body: string }
    | { kind: 'canned'; label: string; body: string },
): Promise<TemplateRowView> {
  if (args.kind === 'canned') return createCannedReply(ctx, { label: args.label, body: args.body });
  return addSystemVariant(ctx, args.key, args.body);
}

export { updateTemplate as updateTemplateForAdmin };
