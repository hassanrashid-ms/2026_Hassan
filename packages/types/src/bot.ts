import { z } from 'zod'

/**
 * NOT part of the frozen SDK contract — ships with the server, same as
 * articles.ts. Shared by the agent console and OpenAPI.
 */

/**
 * A partial save: an omitted key means "leave this field alone", and an explicit
 * null on `prompt` / `rules` means "reset to the default". That is exactly the
 * `BotConfigSave` contract in backend/src/domain/bot/botConfig.ts, so the two
 * cannot drift.
 *
 * No `.min(1)` on the two text fields, deliberately: an empty or whitespace-only
 * value is rejected by the domain's `EmptyBotPrompt`, which names the offending
 * COLUMN so a rules edit is never reported as a prompt error. A schema-level
 * length rule would replace that message with a generic one.
 *
 * `.strict()` so a typo'd key is a 422 rather than a silently ignored no-op save
 * that still writes an audit-free success response.
 */
export const SaveBotConfigBody = z
  .object({
    is_provisioned: z.boolean().optional(),
    prompt: z.string().nullable().optional(),
    rules: z.string().nullable().optional(),
  })
  .strict()
  .refine(
    (body) => body.is_provisioned !== undefined || body.prompt !== undefined || body.rules !== undefined,
    { message: 'At least one of is_provisioned, prompt or rules is required.' },
  )
export type SaveBotConfigBodyValue = z.infer<typeof SaveBotConfigBody>

/**
 * `limit` is coerced because Express query values are always strings. The 200 cap
 * is the page ceiling; `cursor` is opaque and is validated by the server's cursor
 * decoder, not here — its format is not part of the contract.
 */
export const ChangeLogHistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
})
export type ChangeLogHistoryQueryValue = z.infer<typeof ChangeLogHistoryQuery>

/**
 * `prompt` and `rules` are always populated — the resolver substitutes the
 * defaults — and `system_prompt` is the buildSystemPrompt join, the only string
 * the bot is actually sent. The two `*_customized` flags are how the console
 * knows whether to offer a "reset to default" control: they report whether the
 * stored COLUMN is non-null, which is a different question from whether the
 * resolved value happens to equal the default.
 *
 * `updated_at` is null when no row exists yet (nothing has ever been saved).
 */
export type BotConfigView = {
  is_provisioned: boolean
  prompt: string
  rules: string
  system_prompt: string
  is_prompt_customized: boolean
  is_rules_customized: boolean
  updated_at: string | null
}

export type ChangeLogActorView = { id: string; display_name: string; email: string }

/**
 * `field` is the COLUMN name — 'is_provisioned' | 'prompt' | 'rules' — never an
 * API field name, so the trail stays readable against the schema.
 *
 * `before_value` null means the field had no value before (first time it was ever
 * set); `after_value` null means it was cleared back to the default. The two nulls
 * are different facts and must not be collapsed on display.
 *
 * `id` is a string because change_log.id is a bigserial: a JSON number cannot
 * hold it safely and a JS bigint cannot be serialised at all.
 */
export type ChangeLogEntryView = {
  id: string
  field: string
  before_value: unknown
  after_value: unknown
  actor: ChangeLogActorView
  changed_at: string
}

/** `next_cursor` null means this is the last page. */
export type ChangeLogHistoryResponse = {
  entries: ChangeLogEntryView[]
  next_cursor: string | null
}
