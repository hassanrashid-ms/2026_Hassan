// backend/src/domain/bot/contextAssembly.ts
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import type { BotTurnInput } from './botTurn.ts'
import { resolveBotConfig } from './botConfig.ts'
import { article, event, intent, message, subintent } from '../../shared/db/schema/index.ts'
import type { LimitKey } from '@support/types'

export type ChatRole = 'system' | 'user' | 'assistant'
export type ChatMessage = { role: ChatRole; content: string }
export type SubintentOption = { index: number; subintentId: string; label: string }
export type BuildMessagesResult = {
  messages: ChatMessage[]
  /** Ordered options presented in the {{subintents}} block, ending with the Other entry. tools.ts maps classify's subintent_index against this array. */
  subintentOptions: SubintentOption[]
  /** Article ids the player-visible catalogue names — for logging/debug only, never used to validate answer_from_article (that's this turn's search results, see tools.ts). */
  catalogueArticleCount: number
  /** What toolsForPhase filters against — carried out so toolLoop doesn't re-resolve config. */
  enabledTools: ReadonlySet<string>
  /** Per-workspace numeric ceilings — carried out so toolLoop doesn't re-resolve config. */
  resolvedLimits: Record<LimitKey, number>
}

export const MAX_HISTORY_MESSAGES = 20

const PLAYER_CONTEXT_LINE = 'This message is reported by the game client, not verified.'

async function loadSubintentOptions(tx: Tx, workspaceId: string): Promise<SubintentOption[]> {
  const rows = await tx
    .select({ subintentId: subintent.id, subintentName: subintent.name, intentName: intent.name, isSystem: intent.isSystem })
    .from(subintent)
    .innerJoin(intent, eq(intent.id, subintent.intentId))
    .where(and(eq(subintent.workspaceId, workspaceId), isNull(intent.archivedAt)))
    .orderBy(asc(intent.name), asc(subintent.name))

  // The seeded Other/Other pair is presented last, under its own fixed label,
  // never mixed alphabetically into the real taxonomy — the model always
  // finds it in the same place.
  const real = rows.filter((r) => !r.isSystem)
  const options: SubintentOption[] = real.map((r, i) => ({
    index: i,
    subintentId: r.subintentId,
    label: `${r.intentName} → ${r.subintentName}`,
  }))

  const other = rows.find((r) => r.isSystem)
  if (other) {
    options.push({ index: options.length, subintentId: other.subintentId, label: 'Other (none of these fit)' })
  }
  return options
}

// Once a subintent is classified, `classify` is write-once and the model has no further use for
// the category list — omitting it here keeps a long-running conversation's prompt from carrying a
// full taxonomy dump on every turn after classification has already happened.
function renderSubintentBlock(options: SubintentOption[], alreadyClassified: boolean): string {
  if (alreadyClassified) return ''
  const list = options.map((o) => `${o.index}. ${o.label}`).join('\n')
  return `Classify the player's problem into one of these categories:\n${list}`
}

async function renderArticleCatalogue(tx: Tx, workspaceId: string): Promise<{ text: string; count: number }> {
  const rows = await tx
    .select({ title: article.title, intentName: intent.name })
    .from(article)
    .leftJoin(intent, eq(intent.id, article.intentId))
    .where(and(eq(article.workspaceId, workspaceId), eq(article.state, 'published')))
    .orderBy(asc(intent.name), asc(article.title))

  const grouped = new Map<string, string[]>()
  for (const row of rows) {
    const key = row.intentName ?? 'Uncategorized'
    grouped.set(key, [...(grouped.get(key) ?? []), row.title])
  }

  const text = [...grouped.entries()].map(([intentName, titles]) => `${intentName}:\n${titles.map((t) => `- ${t}`).join('\n')}`).join('\n\n')
  return { text, count: rows.length }
}

async function renderStateBlock(tx: Tx, input: BotTurnInput): Promise<string> {
  const lines: string[] = ['── conversation state ──']

  if (input.subintentId) {
    const [row] = await tx
      .select({ subintentName: subintent.name, intentName: intent.name })
      .from(subintent)
      .innerJoin(intent, eq(intent.id, subintent.intentId))
      .where(eq(subintent.id, input.subintentId))
      .limit(1)
    if (row) lines.push(`Classified as: ${row.intentName} → ${row.subintentName}`)
  }

  const [lastArticleEvent] = await tx
    .select({ type: event.type, payload: event.payload })
    .from(event)
    .where(and(eq(event.conversationId, input.conversationId), eq(event.type, 'bot_article_offered')))
    .orderBy(desc(event.occurredAt))
    .limit(1)
  if (lastArticleEvent) {
    const title = (lastArticleEvent.payload as { article_title?: string }).article_title ?? 'an article'
    const [rejection] = await tx
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.conversationId, input.conversationId), eq(event.type, 'bot_article_rejected')))
      .orderBy(desc(event.occurredAt))
      .limit(1)
    lines.push(`Article offered: "${title}"${rejection ? ' — rejected' : ''}`)
  }

  if (input.lastPlayerMessageAt) {
    const gapMs = Date.now() - input.lastPlayerMessageAt.getTime()
    const gapDays = Math.floor(gapMs / (24 * 60 * 60 * 1000))
    if (gapDays >= 1) lines.push(`Player was last here ${gapDays} day${gapDays === 1 ? '' : 's'} ago`)
  }

  return lines.join('\n')
}

function toChatRole(authorType: string): ChatRole | null {
  if (authorType === 'player') return 'user'
  if (authorType === 'bot') return 'assistant'
  return null // system/agent messages never enter the model's transcript
}

/**
 * Renders every input the model needs from columns and events — never an LLM
 * summarisation pass (spec §7): that costs a call, is non-deterministic
 * against temperature 0, and can hallucinate that the bot asked something it
 * did not, the exact failure this block exists to prevent.
 */
export async function buildMessages(tx: Tx, input: BotTurnInput): Promise<BuildMessagesResult> {
  const config = await resolveBotConfig(tx, input.workspaceId)
  const subintentOptions = await loadSubintentOptions(tx, input.workspaceId)
  const catalogue = await renderArticleCatalogue(tx, input.workspaceId)
  const stateBlock = await renderStateBlock(tx, input)

  const systemPrompt = config.systemPrompt
    .replace('{{subintents}}', renderSubintentBlock(subintentOptions, input.subintentId != null))
    .replace('{{articles}}', catalogue.text)

  const rows = await tx.select().from(message).where(eq(message.conversationId, input.conversationId)).orderBy(asc(message.seq))

  const transcript = rows
    .filter((r) => r.visibility === 'public')
    .map((r) => ({ role: toChatRole(r.authorType), body: r.body }))
    .filter((m): m is { role: ChatRole; body: string } => m.role !== null)

  const first = transcript[0]
  const rest = transcript.slice(1)
  const windowed = rest.length > MAX_HISTORY_MESSAGES ? rest.slice(rest.length - MAX_HISTORY_MESSAGES) : rest
  const droppedCount = rest.length - windowed.length

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: PLAYER_CONTEXT_LINE },
    { role: 'user', content: stateBlock },
  ]

  if (first) messages.push({ role: first.role, content: first.body })
  if (droppedCount > 0) messages.push({ role: 'user', content: `[${droppedCount} messages elided]` })
  for (const m of windowed) messages.push({ role: m.role, content: m.body })

  return {
    messages,
    subintentOptions,
    catalogueArticleCount: catalogue.count,
    enabledTools: config.enabledTools,
    resolvedLimits: config.resolvedLimits,
  }
}
