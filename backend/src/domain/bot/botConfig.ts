import { eq } from 'drizzle-orm'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { botConfig } from '../../shared/db/schema/index.ts'
import { buildSystemPrompt, DEFAULT_BOT_PROMPT, DEFAULT_BOT_RULES } from './defaultPrompt.ts'
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts'

/**
 * `prompt` and `rules` are never null: the resolver has already substituted the
 * defaults. They stay separate here — two stored fields, audited separately —
 * and `systemPrompt` is what actually goes to the bot, so no caller joins them
 * itself and they cannot drift apart at different call sites.
 */
export type ResolvedBotConfig = {
  isProvisioned: boolean
  prompt: string
  rules: string
  systemPrompt: string
}

/** Both stored fields resolved, plus the one string the bot is sent. */
function resolved(isProvisioned: boolean, prompt: string | null, rules: string | null): ResolvedBotConfig {
  const resolvedPrompt = prompt ?? DEFAULT_BOT_PROMPT
  const resolvedRules = rules ?? DEFAULT_BOT_RULES
  return {
    isProvisioned,
    prompt: resolvedPrompt,
    rules: resolvedRules,
    systemPrompt: buildSystemPrompt(resolvedPrompt, resolvedRules),
  }
}

/**
 * The one place four different "the bot is off" shapes collapse into one answer:
 * no row at all, `is_provisioned = false`, `prompt IS NULL`, `rules IS NULL`. Every caller
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
    .select({ isProvisioned: botConfig.isProvisioned, prompt: botConfig.prompt, rules: botConfig.rules })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, workspaceId))
    .limit(1)

  if (!row) return resolved(false, null, null)
  return resolved(row.isProvisioned, row.prompt, row.rules)
}

/** The `change_log.entity_type` this slice writes. The only one, for now. */
export const BOT_CONFIG_ENTITY_TYPE = 'bot_config'

/**
 * Thrown rather than stored. An empty or whitespace-only value would be a second
 * representation of "not customised" alongside NULL, and the resolver would have
 * to guess. Clearing a field is an explicit `null`.
 *
 * Carries the field name so an admin editing rules is not told their prompt is
 * wrong. The name is the COLUMN name, matching the audit trail.
 */
export class EmptyBotPrompt extends Error {
  // Declared-then-assigned rather than a `readonly` constructor parameter property:
  // `node --experimental-strip-types` erases types only, and a parameter property
  // needs a transform, so it fails the dev server at load with
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Matches InvalidWorkspaceId.
  readonly field: 'prompt' | 'rules'

  constructor(field: 'prompt' | 'rules' = 'prompt') {
    super(`Bot ${field} cannot be empty — pass null to reset it to the default`)
    this.name = 'EmptyBotPrompt'
    this.field = field
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
  /** Omitted means leave alone; explicit null is a reset to DEFAULT_BOT_RULES. */
  rules?: string | null
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
    throw new EmptyBotPrompt('prompt')
  }
  if (typeof input.rules === 'string' && input.rules.trim() === '') {
    throw new EmptyBotPrompt('rules')
  }

  const [existing] = await tx
    .select({ isProvisioned: botConfig.isProvisioned, prompt: botConfig.prompt, rules: botConfig.rules })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, input.workspaceId))
    .limit(1)

  // An absent row means the same thing as { false, null, null } — the same
  // collapse resolveBotConfig performs — so a first save's before-values are
  // those, not "unknown".
  const beforeProvisioned = existing?.isProvisioned ?? false
  const beforePrompt = existing?.prompt ?? null
  const beforeRules = existing?.rules ?? null

  const afterProvisioned = input.isProvisioned ?? beforeProvisioned
  const afterPrompt = input.prompt === undefined ? beforePrompt : input.prompt
  const afterRules = input.rules === undefined ? beforeRules : input.rules

  await tx
    .insert(botConfig)
    .values({
      workspaceId: input.workspaceId,
      isProvisioned: afterProvisioned,
      prompt: afterPrompt,
      rules: afterRules,
    })
    .onConflictDoUpdate({
      target: botConfig.workspaceId,
      set: {
        isProvisioned: afterProvisioned,
        prompt: afterPrompt,
        rules: afterRules,
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
      { field: 'rules', before: beforeRules, after: afterRules },
    ],
  })

  return resolved(afterProvisioned, afterPrompt, afterRules)
}
