import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { BOT_PROMPT_PLACEHOLDERS, DEFAULT_BOT_PROMPT } from '../src/domain/bot/defaultPrompt.ts'
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

  it('resolves an absent row to off, with the default prompt', async () => {
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved).toEqual({ isProvisioned: false, prompt: DEFAULT_BOT_PROMPT })
  })

  it('resolves a row with a null prompt to the default prompt', async () => {
    await seedBotConfig({ workspaceId, isProvisioned: true, prompt: null })
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved).toEqual({ isProvisioned: true, prompt: DEFAULT_BOT_PROMPT })
  })

  it('returns a stored prompt verbatim', async () => {
    await seedBotConfig({ workspaceId, isProvisioned: true, prompt: '  keep my leading spaces  ' })
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved.prompt).toBe('  keep my leading spaces  ')
  })

  it('cannot tell an absent row from is_provisioned = false — one resolver, one answer', async () => {
    const absent = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    await seedBotConfig({ workspaceId, isProvisioned: false, prompt: null })
    const present = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(present).toEqual(absent)
  })

  it('never leaks another workspace config', async () => {
    const otherWorkspaceId = await seedWorkspace()
    await seedBotConfig({ workspaceId: otherWorkspaceId, isProvisioned: true, prompt: 'theirs' })
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved).toEqual({ isProvisioned: false, prompt: DEFAULT_BOT_PROMPT })
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
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: true, prompt: 'v1' }),
    )
    expect(first).toEqual({ isProvisioned: true, prompt: 'v1' })

    const second = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: 'v2' }),
    )
    expect(second).toEqual({ isProvisioned: true, prompt: 'v2' })

    const { rows } = await ownerPool.query(`select count(*)::int as n from bot_config where workspace_id = $1`, [
      workspaceId,
    ])
    expect(rows[0]).toEqual({ n: 1 })
  })

  it('leaves an omitted field alone, and resets prompt to the default on an explicit null', async () => {
    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: true, prompt: 'custom' }),
    )

    const provisionOnly = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: false }),
    )
    expect(provisionOnly).toEqual({ isProvisioned: false, prompt: 'custom' })

    const cleared = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: null }),
    )
    expect(cleared).toEqual({ isProvisioned: false, prompt: DEFAULT_BOT_PROMPT })

    const { rows } = await ownerPool.query(`select prompt from bot_config where workspace_id = $1`, [workspaceId])
    expect(rows[0]).toEqual({ prompt: null }) // NULL is the only "no prompt" representation
  })

  it('rejects an empty or whitespace-only prompt instead of storing one', async () => {
    for (const prompt of ['', '   ', '\n\t']) {
      await expect(
        withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, prompt })),
        `prompt ${JSON.stringify(prompt)}`,
      ).rejects.toThrow(EmptyBotPrompt)
    }
    const { rows } = await ownerPool.query(`select count(*)::int as n from bot_config`)
    expect(rows[0]).toEqual({ n: 0 })
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
