import { describe, expect, it } from 'vitest'
import { buildArticleSearchParams } from './articleSearch.ts'

describe('buildArticleSearchParams', () => {
  it('omits absent filters entirely', () => {
    expect(buildArticleSearchParams({}).toString()).toBe('')
  })

  it('includes q when present and trimmed non-empty', () => {
    expect(buildArticleSearchParams({ q: '  refund  ' }).toString()).toBe('q=refund')
  })

  it('drops a blank q', () => {
    expect(buildArticleSearchParams({ q: '   ' }).toString()).toBe('')
  })

  it('includes intentId when present', () => {
    expect(buildArticleSearchParams({ intentId: 'abc-123' }).toString()).toBe('intentId=abc-123')
  })

  it('includes both when both are present', () => {
    const params = buildArticleSearchParams({ q: 'refund', intentId: 'abc-123' })
    expect(params.get('q')).toBe('refund')
    expect(params.get('intentId')).toBe('abc-123')
  })
})
