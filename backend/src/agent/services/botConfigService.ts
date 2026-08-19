import { eq } from 'drizzle-orm'
import type { BotConfigView, ChangeLogHistoryResponse } from '@support/types'
import { botConfig } from '../../shared/db/schema/index.ts'
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts'
import { BOT_CONFIG_ENTITY_TYPE, resolveBotConfig, saveBotConfig } from '../../domain/bot/botConfig.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'
import type { ChangeLogCursor } from '../../shared/changeLog/cursor.ts'
import { readChangeLog } from '../../shared/changeLog/readChangeLog.ts'

/**
 * The console needs two things the resolver deliberately does not return: whether
 * each stored COLUMN is non-null (so a "reset to default" control is only offered
 * where there is something to reset) and `updated_at` for the screen's header.
 *
 * Both come from one primary-key read. It sits alongside resolveBotConfig rather
 * than replacing it: collapsing "no row" / false / NULL into an answer is the
 * resolver's job and only the resolver's, or two call sites eventually disagree.
 */
async function readRowMeta(
  tx: Tx,
  workspaceId: string,
): Promise<{ isPromptCustomized: boolean; isRulesCustomized: boolean; updatedAt: Date | null }> {
  const [row] = await tx
    .select({ prompt: botConfig.prompt, rules: botConfig.rules, updatedAt: botConfig.updatedAt })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, workspaceId))
    .limit(1)

  return {
    isPromptCustomized: row?.prompt != null,
    isRulesCustomized: row?.rules != null,
    updatedAt: row?.updatedAt ?? null,
  }
}

/** Shared by the read and the save so one response shape cannot drift from the other. */
async function view(tx: Tx, workspaceId: string): Promise<BotConfigView> {
  const resolved = await resolveBotConfig(tx, workspaceId)
  const meta = await readRowMeta(tx, workspaceId)
  return {
    is_provisioned: resolved.isProvisioned,
    prompt: resolved.prompt,
    rules: resolved.rules,
    system_prompt: resolved.systemPrompt,
    is_prompt_customized: meta.isPromptCustomized,
    is_rules_customized: meta.isRulesCustomized,
    updated_at: meta.updatedAt?.toISOString() ?? null,
  }
}

export async function getBotConfigView(ctx: AgentContext): Promise<BotConfigView> {
  return withWorkspace(ctx.workspaceId, (tx) => view(tx, ctx.workspaceId))
}

export type BotConfigSaveInput = {
  isProvisioned?: boolean
  prompt?: string | null
  rules?: string | null
}

/**
 * One transaction for the upsert, its audit rows, and the re-read that shapes the
 * response — so a client that renders the response is looking at the same state
 * the audit trail describes.
 *
 * `saveBotConfig` owns everything substantive: whitespace rejection
 * (EmptyBotPrompt), the before/after comparison against the absent-row collapse,
 * the ON CONFLICT upsert, and the appendChangeLog call in this same transaction.
 * This function adds the transaction and the actor id, and nothing else. Never
 * write `bot_config` here directly.
 */
export async function saveBotConfigForAgent(ctx: AgentContext, input: BotConfigSaveInput): Promise<BotConfigView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    await saveBotConfig(tx, {
      workspaceId: ctx.workspaceId,
      actorId: ctx.agentId,
      isProvisioned: input.isProvisioned,
      prompt: input.prompt,
      rules: input.rules,
    })
    return view(tx, ctx.workspaceId)
  })
}

/**
 * The audit trail for this workspace's bot config, newest first.
 *
 * The entity is fixed by the server — BOT_CONFIG_ENTITY_TYPE and the caller's own
 * workspace id, which for bot_config IS the entity id. There is deliberately no
 * client-supplied entity_type: the only writer that exists is bot config, and a
 * client-chosen type would turn this into an open query over rows that are not
 * this endpoint's business.
 *
 * `field` values are returned verbatim — they are COLUMN names, and mapping them
 * to API names would make the trail unreadable against the schema.
 */
export async function listBotConfigHistory(
  ctx: AgentContext,
  input: { limit: number; cursor?: ChangeLogCursor },
): Promise<ChangeLogHistoryResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const page = await readChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: BOT_CONFIG_ENTITY_TYPE,
      entityId: ctx.workspaceId,
      limit: input.limit,
      cursor: input.cursor,
    })

    return {
      entries: page.rows.map((row) => ({
        id: row.id,
        field: row.field,
        before_value: row.beforeValue,
        after_value: row.afterValue,
        actor: { id: row.actor.id, display_name: row.actor.displayName, email: row.actor.email },
        changed_at: row.changedAt.toISOString(),
      })),
      next_cursor: page.nextCursor,
    }
  })
}
