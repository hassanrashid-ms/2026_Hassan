import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  BOT_PROMPT_PLACEHOLDERS,
  BOT_RULES_HEADING,
  buildSystemPrompt,
  DEFAULT_BOT_PROMPT,
  DEFAULT_BOT_RULES,
} from '../src/domain/bot/defaultPrompt.ts'
import { SEED_TAXONOMY } from '../src/shared/db/seedTaxonomy.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { EmptyBotPrompt, resolveBotConfig, saveBotConfig } from '../src/domain/bot/botConfig.ts'
import { closeOwnerPool, ownerPool, seedAgent, seedBotConfig, seedWorkspace, truncateAll } from './helpers/db.ts'
import { buildBaselineRules, type RuleEntry } from '../src/domain/bot/rulesCatalog.ts'

describe('DEFAULT_BOT_PROMPT', () => {
  it('contains {{subintents}} and {{articles}}, not {{player_level}} or {{spend_tier}}', () => {
    expect(DEFAULT_BOT_PROMPT).toContain('{{subintents}}')
    expect(DEFAULT_BOT_PROMPT).toContain('{{articles}}')
    expect(DEFAULT_BOT_PROMPT).not.toContain('{{player_level}}')
    expect(DEFAULT_BOT_PROMPT).not.toContain('{{spend_tier}}')
  })

  it('BOT_PROMPT_PLACEHOLDERS still lists all four', () => {
    expect(BOT_PROMPT_PLACEHOLDERS).toEqual(['{{subintents}}', '{{articles}}', '{{player_level}}', '{{spend_tier}}'])
  })

  it('names no real subintent, intent or article — it ships to every workspace', () => {
    const haystack = DEFAULT_BOT_PROMPT.toLowerCase()
    const forbidden = SEED_TAXONOMY.flatMap((intent) => [
      intent.name,
      ...intent.subintents,
      ...intent.articles.map((article) => article.title),
    ])

    expect(forbidden.length).toBeGreaterThan(0) // guard: an empty seed would vacuously pass
    for (const name of forbidden) {
      expect(haystack, `leaks taxonomy name "${name}"`).not.toContain(name.toLowerCase())
    }
  })

  it('is not empty or whitespace — it is the fallback every uncustomised bot runs on', () => {
    expect(DEFAULT_BOT_PROMPT.trim().length).toBeGreaterThan(0)
  })

  it('holds no rules block itself — rules are a separate field, joined only at send time', () => {
    expect(DEFAULT_BOT_PROMPT).not.toContain(BOT_RULES_HEADING)
    expect(DEFAULT_BOT_PROMPT).not.toContain(DEFAULT_BOT_RULES)
  })

  /**
   * Regression guard. The prompt used to say "when you hand off, say plainly that
   * you are passing this to the support team" — but a text reply and a tool call
   * are mutually exclusive in one model response (openaiClient returns `text`
   * only when `toolCalls` is empty), so the model obeyed the sentence and never
   * called `handoff`. toolLoop scored that as an ordinary answer and the
   * conversation stayed bot_active, leaving the player told they had been handed
   * off while the bot kept replying. The prompt must point at the tool.
   */
  it('directs handoff to the tool and never asks the model to announce one in prose', () => {
    expect(DEFAULT_BOT_PROMPT).toContain('handoff tool')
    expect(DEFAULT_BOT_PROMPT.toLowerCase()).not.toContain('say plainly')
  })

  it('requires a search before concluding no article answers the player', () => {
    expect(DEFAULT_BOT_PROMPT).toContain('search_articles')
  })

  /**
   * Regression guard. The prompt used to treat any comprehensible problem statement as
   * search-worthy, so a broad, category-less complaint like "I've got a purchase issue" sent the
   * model straight to search_articles/classify instead of asking what specifically happened.
   * search_articles has zero preconditions in toolLoop.ts — this carve-out is the only thing
   * stopping that jump, so it must stay in the prompt text.
   */
  it('asks a clarifying question before searching or classifying a broad, category-less statement of intent', () => {
    expect(DEFAULT_BOT_PROMPT).toContain('a broad statement of a problem area')
    expect(DEFAULT_BOT_PROMPT).toMatch(/Do not search,\s+classify, or hand off/)
    expect(DEFAULT_BOT_PROMPT).toMatch(/ask one short question|asking what they need help with/)
  })

  /**
   * Regression guard, one level deeper than the one above. A player who names only the area a
   * category sits under (e.g. the single word "purchase", matching the "In-App Purchases" half of
   * "In-App Purchases → Missing Purchase") was enough for the model to pick a specific subintent
   * and search, with zero information distinguishing it from the area's other subintents. The
   * prompt must say that naming the area is not naming the category, even as a follow-up answer.
   */
  it('treats naming only the category area, not a specific problem within it, as still not enough to search', () => {
    expect(DEFAULT_BOT_PROMPT).toContain('naming the area is not naming the category')
    expect(DEFAULT_BOT_PROMPT).toMatch(/not just the\s+area it sits under/)
  })

  /**
   * The prompt has to ask for the article's substance, not a pointer to it.
   * `offer_article` used to post a fixed "Here's an article that might help."
   * while nothing carried the article to the player — they were promised a
   * document, shown nothing, and then asked whether it had solved their problem.
   * The tool now takes the answer itself.
   */
  it('directs the answer through answer_from_article, not a pointer to a document', () => {
    expect(DEFAULT_BOT_PROMPT).toContain('answer_from_article')
    expect(DEFAULT_BOT_PROMPT).not.toContain('offer_article')
  })

  it("requires the article's own wording and forbids adding to it", () => {
    expect(DEFAULT_BOT_PROMPT).toContain("article's own sentences")
    expect(DEFAULT_BOT_PROMPT).toMatch(/Do not add a step, a cause, a timeframe or a reassurance the article does not\ncontain/)
  })

  /**
   * The three-sentence rule and "keep every step" are in direct conflict on a
   * multi-step article: obeying the shorter one silently drops steps, which is
   * the same fabrication risk wearing the opposite coat.
   */
  it('exempts an article-derived answer from the three-sentence limit rather than forcing steps to be dropped', () => {
    expect(DEFAULT_BOT_RULES).toContain('three short sentences')
    expect(DEFAULT_BOT_RULES).toContain('never drop or merge a step to fit')
  })
})

describe('DEFAULT_BOT_RULES', () => {
  it('is not empty or whitespace — it is the fallback every uncustomised bot runs on', () => {
    expect(DEFAULT_BOT_RULES.trim().length).toBeGreaterThan(0)
  })

  it('names no real subintent, intent or article — it ships to every workspace', () => {
    const haystack = DEFAULT_BOT_RULES.toLowerCase()
    const forbidden = SEED_TAXONOMY.flatMap((intent) => [
      intent.name,
      ...intent.subintents,
      ...intent.articles.map((article) => article.title),
    ])

    expect(forbidden.length).toBeGreaterThan(0) // guard: an empty seed would vacuously pass
    for (const name of forbidden) {
      expect(haystack, `leaks taxonomy name "${name}"`).not.toContain(name.toLowerCase())
    }
  })
})

describe('buildSystemPrompt', () => {
  const rule = (text: string, enabled = true): RuleEntry => ({
    key: text,
    text,
    enabled,
    locked: false,
    source: 'builtin',
  })

  it('sends the prompt and enabled rule texts as one string, prompt first and rules last', () => {
    const built = buildSystemPrompt('PROMPT BODY', [rule('RULE ONE')])
    expect(built).toContain('PROMPT BODY')
    expect(built).toContain('RULE ONE')
    expect(built.indexOf('PROMPT BODY')).toBeLessThan(built.indexOf(BOT_RULES_HEADING))
    expect(built.indexOf(BOT_RULES_HEADING)).toBeLessThan(built.indexOf('RULE ONE'))
  })

  it('omits a disabled rule entirely', () => {
    const built = buildSystemPrompt('P', [rule('KEEP ME'), rule('DROP ME', false)])
    expect(built).toContain('KEEP ME')
    expect(built).not.toContain('DROP ME')
  })

  it('renders each enabled rule as "- {text}", in array order', () => {
    const built = buildSystemPrompt('P', [rule('first'), rule('second')])
    const rulesBlock = built.slice(built.indexOf(BOT_RULES_HEADING))
    expect(rulesBlock.indexOf('- first')).toBeLessThan(rulesBlock.indexOf('- second'))
  })

  it('PARITY: an unmodified catalog baseline renders byte-identical to the old string-rules formula', () => {
    const built = buildSystemPrompt(DEFAULT_BOT_PROMPT, buildBaselineRules())
    const oldFormula = `${DEFAULT_BOT_PROMPT.trimEnd()}\n\n${BOT_RULES_HEADING}\n${DEFAULT_BOT_RULES.trim()}`
    expect(built).toBe(oldFormula)
  })

  it('keeps the placeholders intact — the orchestrator substitutes after the join', () => {
    const built = buildSystemPrompt(DEFAULT_BOT_PROMPT, buildBaselineRules())
    expect(built).toContain('{{subintents}}')
    expect(built).toContain('{{articles}}')
  })
})

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

describe('resolveBotConfig', () => {
  let workspaceId: string

  beforeEach(async () => {
    await truncateAll()
    workspaceId = await seedWorkspace()
  })

  it('resolves an absent row to off, with the default prompt and the default rules', async () => {
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved).toEqual({
      isProvisioned: false,
      prompt: DEFAULT_BOT_PROMPT,
      rules: DEFAULT_BOT_RULES,
      systemPrompt: buildSystemPrompt(DEFAULT_BOT_PROMPT, DEFAULT_BOT_RULES),
    })
  })

  it('resolves a null prompt and null rules to their defaults, independently', async () => {
    await seedBotConfig({ workspaceId, isProvisioned: true, prompt: null, rules: 'only rules customised' })
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved.prompt).toBe(DEFAULT_BOT_PROMPT)
    expect(resolved.rules).toBe('only rules customised')

    await truncateAll()
    workspaceId = await seedWorkspace()
    await seedBotConfig({ workspaceId, isProvisioned: true, prompt: 'only prompt customised', rules: null })
    const other = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(other.prompt).toBe('only prompt customised')
    expect(other.rules).toBe(DEFAULT_BOT_RULES)
  })

  it('returns a stored prompt and stored rules verbatim', async () => {
    await seedBotConfig({
      workspaceId,
      isProvisioned: true,
      prompt: '  keep my leading spaces  ',
      rules: '  and mine  ',
    })
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved.prompt).toBe('  keep my leading spaces  ')
    expect(resolved.rules).toBe('  and mine  ')
  })

  it('keeps prompt and rules separate on the way out, and joined only in systemPrompt', async () => {
    await seedBotConfig({ workspaceId, isProvisioned: true, prompt: 'MY PROMPT', rules: 'MY RULES' })
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))

    expect(resolved.prompt).toBe('MY PROMPT')
    expect(resolved.rules).toBe('MY RULES')
    expect(resolved.prompt).not.toContain('MY RULES')
    expect(resolved.systemPrompt).toContain('MY PROMPT')
    expect(resolved.systemPrompt).toContain('MY RULES')
  })

  it('cannot tell an absent row from is_provisioned = false — one resolver, one answer', async () => {
    const absent = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    await seedBotConfig({ workspaceId, isProvisioned: false, prompt: null })
    const present = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(present).toEqual(absent)
  })

  it('never leaks another workspace config', async () => {
    const otherWorkspaceId = await seedWorkspace()
    await seedBotConfig({ workspaceId: otherWorkspaceId, isProvisioned: true, prompt: 'theirs', rules: 'theirs' })
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved.prompt).toBe(DEFAULT_BOT_PROMPT)
    expect(resolved.rules).toBe(DEFAULT_BOT_RULES)
    expect(resolved.isProvisioned).toBe(false)
  })
})

describe('saveBotConfig', () => {
  let workspaceId: string
  let actorId: string

  beforeEach(async () => {
    await truncateAll()
    workspaceId = await seedWorkspace()
    actorId = await seedAgent()
  })

  it('creates the row on first save and upserts on the second rather than erroring', async () => {
    const first = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: true, prompt: 'v1', rules: 'r1' }),
    )
    expect(first).toMatchObject({ isProvisioned: true, prompt: 'v1', rules: 'r1' })

    const second = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: 'v2' }),
    )
    expect(second).toMatchObject({ isProvisioned: true, prompt: 'v2', rules: 'r1' })

    const { rows } = await ownerPool.query(`select count(*)::int as n from bot_config where workspace_id = $1`, [
      workspaceId,
    ])
    expect(rows[0]).toEqual({ n: 1 })
  })

  it('leaves an omitted field alone, and resets to the default on an explicit null', async () => {
    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: true, prompt: 'custom', rules: 'custom rules' }),
    )

    const provisionOnly = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: false }),
    )
    expect(provisionOnly).toMatchObject({ isProvisioned: false, prompt: 'custom', rules: 'custom rules' })

    const cleared = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: null }),
    )
    // Clearing the prompt must not clear the rules — they are independent fields.
    expect(cleared).toMatchObject({ isProvisioned: false, prompt: DEFAULT_BOT_PROMPT, rules: 'custom rules' })

    const { rows } = await ownerPool.query(`select prompt, rules from bot_config where workspace_id = $1`, [
      workspaceId,
    ])
    expect(rows[0]).toEqual({ prompt: null, rules: 'custom rules' }) // NULL is the only "no prompt" representation

    const rulesCleared = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, rules: null }),
    )
    expect(rulesCleared).toMatchObject({ prompt: DEFAULT_BOT_PROMPT, rules: DEFAULT_BOT_RULES })
  })

  it('rejects an empty or whitespace-only prompt or rules instead of storing one', async () => {
    for (const blank of ['', '   ', '\n\t']) {
      await expect(
        withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, prompt: blank })),
        `prompt ${JSON.stringify(blank)}`,
      ).rejects.toThrow(EmptyBotPrompt)
      await expect(
        withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, rules: blank })),
        `rules ${JSON.stringify(blank)}`,
      ).rejects.toThrow(EmptyBotPrompt)
    }
    const { rows } = await ownerPool.query(`select count(*)::int as n from bot_config`)
    expect(rows[0]).toEqual({ n: 0 })
  })

  it('names the offending field, so a rules edit is not reported as a prompt error', async () => {
    await expect(
      withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, rules: '  ' })),
    ).rejects.toThrow(/rules/)
  })

  it('bumps updated_at on a real change without touching created_at', async () => {
    await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, prompt: 'v1' }))
    const before = await ownerPool.query<{ created_at: Date; updated_at: Date }>(
      `select created_at, updated_at from bot_config where workspace_id = $1`,
      [workspaceId],
    )
    await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, prompt: 'v2' }))
    const after = await ownerPool.query<{ created_at: Date; updated_at: Date }>(
      `select created_at, updated_at from bot_config where workspace_id = $1`,
      [workspaceId],
    )

    expect(after.rows[0]!.created_at.getTime()).toBe(before.rows[0]!.created_at.getTime())
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThanOrEqual(before.rows[0]!.updated_at.getTime())
  })
})
