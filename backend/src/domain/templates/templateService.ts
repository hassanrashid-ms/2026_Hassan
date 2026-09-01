import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { messageTemplate } from '../../shared/db/schema/index.ts';
import {
  getCachedTemplates,
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
const DEFAULT_SYSTEM_MESSAGES: Record<SystemMessageKey, string[]> = {
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

/** For the four singleton system keys. Use getHandoffMessage for 'handoff'. */
export async function getSystemMessage(
  tx: Tx,
  workspaceId: string,
  key: Exclude<SystemMessageKey, 'handoff'>,
): Promise<string> {
  const { system } = await loadTemplates(tx, workspaceId);
  const active = system[key];
  return active.length > 0 ? active[0]! : DEFAULT_SYSTEM_MESSAGES[key][0]!;
}

/**
 * Random rather than round-robin — same reasoning as the pre-feature
 * pickHandoffMessage() in bot/messages.ts, now over a workspace-configurable
 * list instead of the hardcoded one. Callers must not cache the result across
 * messages, same caveat as before.
 */
export async function getHandoffMessage(tx: Tx, workspaceId: string): Promise<string> {
  const { system } = await loadTemplates(tx, workspaceId);
  const variants = system.handoff.length > 0 ? system.handoff : DEFAULT_SYSTEM_MESSAGES.handoff;
  return variants[Math.floor(Math.random() * variants.length)]!;
}

export async function listCannedReplies(
  tx: Tx,
  workspaceId: string,
): Promise<CannedReplyEntry[]> {
  const { canned } = await loadTemplates(tx, workspaceId);
  return canned;
}
