import { eq } from 'drizzle-orm'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { botConfig } from '../../shared/db/schema/index.ts'
import { DEFAULT_BOT_PROMPT } from './defaultPrompt.ts'

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
