import { describe, expect, it } from 'vitest'
import { ChangeLogHistoryQuery, SaveBotConfigBody } from '../src/bot.ts'

describe('SaveBotConfigBody', () => {
  it('accepts a single field on its own', () => {
    expect(SaveBotConfigBody.safeParse({ is_provisioned: true }).success).toBe(true)
    expect(SaveBotConfigBody.safeParse({ prompt: 'Be helpful.' }).success).toBe(true)
    expect(SaveBotConfigBody.safeParse({ rules: 'Never promise a refund.' }).success).toBe(true)
  })

  it('accepts explicit null as a reset for prompt and rules', () => {
    const parsed = SaveBotConfigBody.safeParse({ prompt: null, rules: null })
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ prompt: null, rules: null })
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
