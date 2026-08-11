import { describe, expect, it } from 'vitest'
import { BOT_PROMPT_PLACEHOLDERS, DEFAULT_BOT_PROMPT } from '../src/domain/bot/defaultPrompt.ts'
import { SEED_TAXONOMY } from '../src/shared/db/seedTaxonomy.ts'

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
