import { describe, expect, it } from 'vitest'
import { canEditFields, canPublish, parseKeywordsInput } from './articleForm.ts'

describe('canEditFields', () => {
  it('allows edits only while draft', () => {
    expect(canEditFields('draft')).toBe(true)
    expect(canEditFields('published')).toBe(false)
    expect(canEditFields('archived')).toBe(false)
  })
})

describe('canPublish', () => {
  it('requires draft state and non-blank title and body', () => {
    expect(canPublish('draft', 'Title', 'Body')).toBe(true)
    expect(canPublish('draft', '  ', 'Body')).toBe(false)
    expect(canPublish('draft', 'Title', '  ')).toBe(false)
    expect(canPublish('published', 'Title', 'Body')).toBe(false)
  })
})

describe('parseKeywordsInput', () => {
  it('splits on commas, trims, drops empties, and dedupes', () => {
    expect(parseKeywordsInput('refund, billing ,, refund')).toEqual(['refund', 'billing'])
  })

  it('returns an empty array for blank input', () => {
    expect(parseKeywordsInput('   ')).toEqual([])
  })
})
