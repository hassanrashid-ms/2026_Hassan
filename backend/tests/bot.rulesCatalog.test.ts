import { describe, expect, it } from 'vitest'
import { DEFAULT_BOT_RULES } from '../src/domain/bot/defaultPrompt.ts'
import {
  BUILTIN_RULE_KEYS,
  DEFAULT_BOT_RULES_CATALOG,
  LOCKED_RULE_KEYS,
  buildBaselineRules,
  deriveEnforcement,
} from '../src/domain/bot/rulesCatalog.ts'

describe('DEFAULT_BOT_RULES_CATALOG', () => {
  it('is a verbatim split of DEFAULT_BOT_RULES, in order, every entry enabled by default', () => {
    const rebuilt = DEFAULT_BOT_RULES_CATALOG.map((r) => `- ${r.text}`).join('\n')
    expect(rebuilt).toBe(DEFAULT_BOT_RULES)
    expect(DEFAULT_BOT_RULES_CATALOG.every((r) => r.defaultEnabled)).toBe(true)
  })

  it('has exactly 8 entries, matching today\'s catalog size', () => {
    expect(DEFAULT_BOT_RULES_CATALOG).toHaveLength(8)
  })

  it('locks exactly handoff_immediate and no_credentials', () => {
    expect(LOCKED_RULE_KEYS).toEqual(new Set(['handoff_immediate', 'no_credentials']))
  })

  it('marks no_invented_facts as code-enforced and every other builtin as prompt-enforced', () => {
    const byKey = new Map(DEFAULT_BOT_RULES_CATALOG.map((r) => [r.key, r.enforcement]))
    expect(byKey.get('no_invented_facts')).toBe('code')
    for (const [key, enforcement] of byKey) {
      if (key !== 'no_invented_facts') expect(enforcement).toBe('prompt')
    }
  })
})

describe('BUILTIN_RULE_KEYS', () => {
  it('contains every catalog key', () => {
    expect(BUILTIN_RULE_KEYS).toEqual(new Set(DEFAULT_BOT_RULES_CATALOG.map((r) => r.key)))
  })
})

describe('deriveEnforcement', () => {
  it('looks up a builtin key in the catalog', () => {
    expect(deriveEnforcement({ key: 'no_invented_facts', source: 'builtin' })).toBe('code')
    expect(deriveEnforcement({ key: 'no_regreet', source: 'builtin' })).toBe('prompt')
  })

  it('is always prompt for a custom entry, regardless of key', () => {
    expect(deriveEnforcement({ key: 'anything', source: 'custom' })).toBe('prompt')
  })
})

describe('buildBaselineRules', () => {
  it('returns one RuleEntry per catalog row, all enabled, source builtin, in catalog order', () => {
    const baseline = buildBaselineRules()
    expect(baseline).toHaveLength(8)
    expect(baseline.every((r) => r.enabled && r.source === 'builtin')).toBe(true)
    expect(baseline.map((r) => r.key)).toEqual(DEFAULT_BOT_RULES_CATALOG.map((r) => r.key))
  })

  it('marks locked entries locked and everything else unlocked', () => {
    const baseline = buildBaselineRules()
    const locked = baseline.filter((r) => r.locked).map((r) => r.key)
    expect(new Set(locked)).toEqual(LOCKED_RULE_KEYS)
  })
})
