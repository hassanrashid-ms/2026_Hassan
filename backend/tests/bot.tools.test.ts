import { describe, it, expect } from 'vitest'
import { toolsForPhase, resolveClassifyIndex, CONFIRM_RESOLUTION_TOOL_NAME } from '../src/domain/bot/tools.ts'

describe('toolsForPhase', () => {
  it('omits confirm_resolution when phase is none', () => {
    const names = toolsForPhase('none').map((t: any) => t.function.name)
    expect(names).not.toContain(CONFIRM_RESOLUTION_TOOL_NAME)
    expect(names).toEqual(expect.arrayContaining(['search_articles', 'classify', 'answer_from_article', 'handoff']))
  })

  it('includes confirm_resolution when phase is bot_article', () => {
    const names = toolsForPhase('bot_article').map((t: any) => t.function.name)
    expect(names).toContain(CONFIRM_RESOLUTION_TOOL_NAME)
  })
})

describe('resolveClassifyIndex', () => {
  const options = [
    { index: 0, subintentId: 'a', label: 'A' },
    { index: 1, subintentId: 'b', label: 'B' },
  ]

  it('resolves a valid index', () => {
    expect(resolveClassifyIndex(options, 1)).toEqual(options[1])
  })

  it('returns null for an out-of-range index', () => {
    expect(resolveClassifyIndex(options, 99)).toBeNull()
    expect(resolveClassifyIndex(options, -1)).toBeNull()
  })
})
