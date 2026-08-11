import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { BOT_PROMPT_PLACEHOLDERS, DEFAULT_BOT_PROMPT } from '../src/domain/bot/defaultPrompt.ts'
import { SEED_TAXONOMY } from '../src/shared/db/seedTaxonomy.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { resolveBotConfig } from '../src/domain/bot/botConfig.ts'
import { closeOwnerPool, ownerPool, seedBotConfig, seedWorkspace, truncateAll } from './helpers/db.ts'

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
