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

describe('DEFAULT_BOT_PROMPT', () => {
  it('carries every placeholder the orchestrator substitutes', () => {
    for (const placeholder of BOT_PROMPT_PLACEHOLDERS) {
      expect(DEFAULT_BOT_PROMPT, `missing ${placeholder}`).toContain(placeholder)
    }
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
  it('sends both stored fields as one string, prompt first and rules last', () => {
    const built = buildSystemPrompt('PROMPT BODY', 'RULE ONE')
    expect(built).toContain('PROMPT BODY')
    expect(built).toContain('RULE ONE')
    expect(built.indexOf('PROMPT BODY')).toBeLessThan(built.indexOf(BOT_RULES_HEADING))
    expect(built.indexOf(BOT_RULES_HEADING)).toBeLessThan(built.indexOf('RULE ONE'))
  })

  it('keeps the placeholders intact — the orchestrator substitutes after the join', () => {
    const built = buildSystemPrompt(DEFAULT_BOT_PROMPT, DEFAULT_BOT_RULES)
    for (const placeholder of BOT_PROMPT_PLACEHOLDERS) {
      expect(built, `missing ${placeholder}`).toContain(placeholder)
    }
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
