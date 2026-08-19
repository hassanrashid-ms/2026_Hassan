import { describe, expect, it } from 'vitest'
import { ChangeLogHistoryQuery, RollbackBotConfigBody, SaveBotConfigBody } from '../src/bot.ts'

describe('SaveBotConfigBody', () => {
  it('accepts a single field on its own', () => {
    expect(SaveBotConfigBody.safeParse({ is_provisioned: true }).success).toBe(true)
    expect(SaveBotConfigBody.safeParse({ prompt: 'Be helpful.' }).success).toBe(true)
    expect(
      SaveBotConfigBody.safeParse({
        rules: [{ key: 'no_regreet', text: 'Do not greet twice.', enabled: true, locked: false, source: 'builtin' }],
      }).success,
    ).toBe(true)
  })

  it('accepts explicit null as a reset for prompt, rules, tools_config and limits_config', () => {
    const parsed = SaveBotConfigBody.safeParse({ prompt: null, rules: null, tools_config: null, limits_config: null })
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ prompt: null, rules: null, tools_config: null, limits_config: null })
  })

  it('rejects an empty body — a save that changes nothing is a client bug', () => {
    expect(SaveBotConfigBody.safeParse({}).success).toBe(false)
  })

  // The domain owns this rejection: EmptyBotPrompt names the offending column,
  // and a schema-level min(1) would replace that with a generic field error.
  it('lets a whitespace-only prompt through to the domain', () => {
    expect(SaveBotConfigBody.safeParse({ prompt: '   ' }).success).toBe(true)
  })

  it('rejects a wrong type and an unknown key', () => {
    expect(SaveBotConfigBody.safeParse({ is_provisioned: 'yes' }).success).toBe(false)
    expect(SaveBotConfigBody.safeParse({ is_provisioned: true, nope: 1 }).success).toBe(false)
  })

  it('rejects null for is_provisioned — there is no "unset" bot switch', () => {
    expect(SaveBotConfigBody.safeParse({ is_provisioned: null }).success).toBe(false)
  })
})

describe('ChangeLogHistoryQuery', () => {
  it('defaults limit to 50 when absent', () => {
    const parsed = ChangeLogHistoryQuery.parse({})
    expect(parsed.limit).toBe(50)
    expect(parsed.cursor).toBeUndefined()
  })

  it('coerces a string limit, because query strings are strings', () => {
    expect(ChangeLogHistoryQuery.parse({ limit: '10' }).limit).toBe(10)
  })

  it('rejects a limit outside 1..200 and a non-integer limit', () => {
    expect(ChangeLogHistoryQuery.safeParse({ limit: '0' }).success).toBe(false)
    expect(ChangeLogHistoryQuery.safeParse({ limit: '201' }).success).toBe(false)
    expect(ChangeLogHistoryQuery.safeParse({ limit: '1.5' }).success).toBe(false)
  })

  it('keeps an opaque cursor as an unvalidated string', () => {
    expect(ChangeLogHistoryQuery.parse({ cursor: 'abc' }).cursor).toBe('abc')
  })
})

describe('RuleEntrySchema (via SaveBotConfigBody.rules)', () => {
  it('rejects an entry carrying enforcement — it is never client-settable', () => {
    const parsed = SaveBotConfigBody.safeParse({
      rules: [{ key: 'k', text: 't', enabled: true, locked: false, source: 'custom', enforcement: 'code' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an entry with empty text', () => {
    const parsed = SaveBotConfigBody.safeParse({
      rules: [{ key: 'k', text: '', enabled: true, locked: false, source: 'custom' }],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('ToolToggleSchema (via SaveBotConfigBody.tools_config)', () => {
  it('accepts every toggleable tool name', () => {
    const parsed = SaveBotConfigBody.safeParse({
      tools_config: [
        { tool: 'search_articles', enabled: true },
        { tool: 'classify', enabled: true },
        { tool: 'answer_from_article', enabled: false },
        { tool: 'confirm_resolution', enabled: true },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown tool name, including handoff', () => {
    expect(SaveBotConfigBody.safeParse({ tools_config: [{ tool: 'handoff', enabled: false }] }).success).toBe(false)
    expect(SaveBotConfigBody.safeParse({ tools_config: [{ tool: 'nope', enabled: true }] }).success).toBe(false)
  })
})

describe('LimitToggleSchema (via SaveBotConfigBody.limits_config)', () => {
  it('accepts every limit key', () => {
    const parsed = SaveBotConfigBody.safeParse({
      limits_config: [
        { key: 'max_bot_messages', value: 10 },
        { key: 'max_tool_calls_per_turn', value: 5 },
        { key: 'max_articles_per_turn', value: 2 },
        { key: 'max_unhelped_replies', value: 4 },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown key', () => {
    expect(SaveBotConfigBody.safeParse({ limits_config: [{ key: 'nope', value: 5 }] }).success).toBe(false)
  })

  it('rejects a non-positive-integer value', () => {
    expect(SaveBotConfigBody.safeParse({ limits_config: [{ key: 'max_bot_messages', value: 0 }] }).success).toBe(
      false,
    )
    expect(
      SaveBotConfigBody.safeParse({ limits_config: [{ key: 'max_bot_messages', value: 2.5 }] }).success,
    ).toBe(false)
  })
})

describe('RollbackBotConfigBody', () => {
  it('accepts a valid rollback request', () => {
    expect(
      RollbackBotConfigBody.safeParse({ field: 'rules', change_log_id: '42', side: 'before' }).success,
    ).toBe(true)
  })

  it('accepts limits_config as a rollback field', () => {
    expect(
      RollbackBotConfigBody.safeParse({ field: 'limits_config', change_log_id: '42', side: 'before' }).success,
    ).toBe(true)
  })

  it('rejects an unknown field or side', () => {
    expect(RollbackBotConfigBody.safeParse({ field: 'nope', change_log_id: '1', side: 'before' }).success).toBe(false)
    expect(RollbackBotConfigBody.safeParse({ field: 'rules', change_log_id: '1', side: 'sideways' }).success).toBe(
      false,
    )
  })
})
