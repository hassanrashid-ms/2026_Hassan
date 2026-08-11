import { eq } from 'drizzle-orm'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { botConfig } from '../../shared/db/schema/index.ts'
import { DEFAULT_BOT_PROMPT } from './defaultPrompt.ts'
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts'

/** `prompt` is never null: the resolver has already substituted the default. */
export type ResolvedBotConfig = {
  isProvisioned: boolean
  prompt: string
}

/**
 * The one place three different "the bot is off" shapes collapse into one answer:
 * no row at all, `is_provisioned = false`, and `prompt IS NULL`. Every caller
 * goes through here, so an absent row and an explicit false can never diverge —
 * and no caller ever has to know which of the three it hit, or handle a null
 * prompt.
 *
 * `is_provisioned = false` means every message on this workspace takes the same
 * fallback path as "bot disabled": no bot reply, straight to the human queue.
 *
 * The explicit workspace predicate is belt-and-braces on top of RLS, matching
 * the codebase rule that scoped reads name their workspace.
 */
export async function resolveBotConfig(tx: Tx, workspaceId: string): Promise<ResolvedBotConfig> {
  const [row] = await tx
    .select({ isProvisioned: botConfig.isProvisioned, prompt: botConfig.prompt })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, workspaceId))
    .limit(1)

  if (!row) return { isProvisioned: false, prompt: DEFAULT_BOT_PROMPT }
  return { isProvisioned: row.isProvisioned, prompt: row.prompt ?? DEFAULT_BOT_PROMPT }
}

/** The `change_log.entity_type` this slice writes. The only one, for now. */
export const BOT_CONFIG_ENTITY_TYPE = 'bot_config'

/**
 * Thrown rather than stored. An empty or whitespace-only prompt would be a second
 * representation of "no prompt" alongside NULL, and the resolver would have to
 * guess. Clearing a prompt is `prompt: null`, explicitly.
 */
export class EmptyBotPrompt extends Error {
  constructor() {
    super('Bot prompt cannot be empty — pass null to reset it to the default')
    this.name = 'EmptyBotPrompt'
  }
}

export type BotConfigSave = {
  workspaceId: string
  /** The authenticated agent. Attribution is not optional. */
  actorId: string
  /** Omitted means leave alone. */
  isProvisioned?: boolean
  /** Omitted means leave alone; explicit null is a reset to DEFAULT_BOT_PROMPT. */
  prompt?: string | null
}

/**
 * The only way `bot_config` is written. The upsert and its audit rows land in the
 * caller's single transaction, so a config change that leaves no audit row is
 * impossible, and a failed audit write rolls the config change back.
 *
 * Audited field names are the COLUMN names, so the trail stays readable against
 * the schema when an API shape changes.
 *
 * A first save that sets both fields to their already-resolved defaults writes no
 * audit row: an absent row and `{ false, null }` resolve identically, so nothing
 * observable changed. The row still gets created.
 */
export async function saveBotConfig(tx: Tx, input: BotConfigSave): Promise<ResolvedBotConfig> {
  if (typeof input.prompt === 'string' && input.prompt.trim() === '') {
    throw new EmptyBotPrompt()
  }

  const [existing] = await tx
    .select({ isProvisioned: botConfig.isProvisioned, prompt: botConfig.prompt })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, input.workspaceId))
    .limit(1)

  // An absent row means the same thing as { false, null } — the same collapse
  // resolveBotConfig performs — so a first save's before-values are those, not
  // "unknown".
  const beforeProvisioned = existing?.isProvisioned ?? false
  const beforePrompt = existing?.prompt ?? null

  const afterProvisioned = input.isProvisioned ?? beforeProvisioned
  const afterPrompt = input.prompt === undefined ? beforePrompt : input.prompt

  await tx
    .insert(botConfig)
    .values({
      workspaceId: input.workspaceId,
      isProvisioned: afterProvisioned,
      prompt: afterPrompt,
    })
    .onConflictDoUpdate({
      target: botConfig.workspaceId,
      set: {
        isProvisioned: afterProvisioned,
        prompt: afterPrompt,
        // Explicit, because there is no trigger — see the schema comment.
        updatedAt: new Date(),
      },
    })

  await appendChangeLog(tx, {
    workspaceId: input.workspaceId,
    entityType: BOT_CONFIG_ENTITY_TYPE,
    entityId: input.workspaceId,
    actorId: input.actorId,
    changes: [
      { field: 'is_provisioned', before: beforeProvisioned, after: afterProvisioned },
      { field: 'prompt', before: beforePrompt, after: afterPrompt },
    ],
  })

  return {
    isProvisioned: afterProvisioned,
    prompt: afterPrompt ?? DEFAULT_BOT_PROMPT,
  }
}
