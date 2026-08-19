import { describe, expect, it } from 'vitest'
import {
  FORM_FIELD_TYPES,
  formAnswerValueSchemas,
  formFieldsSchema,
  publishedFormFieldsSchema,
  type FormField,
} from '../src/index.ts'

const field = (over: Partial<FormField> = {}): FormField => ({
  key: 'store',
  label: 'Store',
  type: 'short_text',
  isRequired: true,
  position: 0,
  ...over,
})

describe('FORM_FIELD_TYPES', () => {
  it('is the canonical seven, in the order the pg enum declares them', () => {
    expect(FORM_FIELD_TYPES).toEqual([
      'short_text',
      'long_text',
      'number',
      'date',
      'time',
      'choice',
      'attachment',
    ])
  })
})

describe('formFieldsSchema', () => {
  it('accepts a well-formed array', () => {
    const fields = [field(), field({ key: 'note', type: 'long_text', position: 1, isRequired: false })]
    expect(formFieldsSchema.safeParse(fields).success).toBe(true)
  })

  it('rejects a duplicate key', () => {
    const fields = [field(), field({ position: 1 })]
    expect(formFieldsSchema.safeParse(fields).success).toBe(false)
  })

  it('rejects a duplicate position', () => {
    const fields = [field(), field({ key: 'other' })]
    expect(formFieldsSchema.safeParse(fields).success).toBe(false)
  })

  it('rejects a choice field with no options', () => {
    expect(formFieldsSchema.safeParse([field({ type: 'choice' })]).success).toBe(false)
  })

  it('rejects a non-choice field carrying options', () => {
    expect(formFieldsSchema.safeParse([field({ options: ['a', 'b'] })]).success).toBe(false)
  })

  it('rejects a choice field with fewer than two options', () => {
    expect(formFieldsSchema.safeParse([field({ type: 'choice', options: ['only'] })]).success).toBe(false)
  })

  it('rejects a key that violates the pattern', () => {
    for (const key of ['Store', 'store-id', 'store id', '']) {
      expect(formFieldsSchema.safeParse([field({ key })]).success, key).toBe(false)
    }
  })

  it('allows an empty array — a draft version has no fields yet', () => {
    expect(formFieldsSchema.safeParse([]).success).toBe(true)
  })
})

describe('publishedFormFieldsSchema', () => {
  it('rejects an empty array — a published version with no questions asks nothing', () => {
    expect(publishedFormFieldsSchema.safeParse([]).success).toBe(false)
  })

  it('accepts a non-empty well-formed array', () => {
    expect(publishedFormFieldsSchema.safeParse([field()]).success).toBe(true)
  })
})

describe('formAnswerValueSchemas', () => {
  it('covers every declared field type', () => {
    expect(Object.keys(formAnswerValueSchemas).sort()).toEqual([...FORM_FIELD_TYPES].sort())
  })

  it('bounds short_text at 1..500 and long_text at 1..5000', () => {
    expect(formAnswerValueSchemas.short_text.safeParse('').success).toBe(false)
    expect(formAnswerValueSchemas.short_text.safeParse('a'.repeat(500)).success).toBe(true)
    expect(formAnswerValueSchemas.short_text.safeParse('a'.repeat(501)).success).toBe(false)
    expect(formAnswerValueSchemas.long_text.safeParse('').success).toBe(false)
    expect(formAnswerValueSchemas.long_text.safeParse('a'.repeat(5000)).success).toBe(true)
    expect(formAnswerValueSchemas.long_text.safeParse('a'.repeat(5001)).success).toBe(false)
  })

  it('requires a finite number', () => {
    expect(formAnswerValueSchemas.number.safeParse(0).success).toBe(true)
    expect(formAnswerValueSchemas.number.safeParse(-3.5).success).toBe(true)
    expect(formAnswerValueSchemas.number.safeParse(Number.POSITIVE_INFINITY).success).toBe(false)
    expect(formAnswerValueSchemas.number.safeParse(Number.NaN).success).toBe(false)
    expect(formAnswerValueSchemas.number.safeParse('3').success).toBe(false)
  })

  it('requires YYYY-MM-DD for date and rejects an impossible month', () => {
    expect(formAnswerValueSchemas.date.safeParse('2026-08-17').success).toBe(true)
    expect(formAnswerValueSchemas.date.safeParse('2026-13-01').success).toBe(false)
    expect(formAnswerValueSchemas.date.safeParse('2026-8-17').success).toBe(false)
    expect(formAnswerValueSchemas.date.safeParse('17/08/2026').success).toBe(false)
  })

  it('requires 24-hour HH:mm for time', () => {
    expect(formAnswerValueSchemas.time.safeParse('00:00').success).toBe(true)
    expect(formAnswerValueSchemas.time.safeParse('23:59').success).toBe(true)
    expect(formAnswerValueSchemas.time.safeParse('24:00').success).toBe(false)
    expect(formAnswerValueSchemas.time.safeParse('1:5').success).toBe(false)
  })

  it('validates a choice as a non-empty string — membership is checked against the field, not here', () => {
    expect(formAnswerValueSchemas.choice.safeParse('Other').success).toBe(true)
    expect(formAnswerValueSchemas.choice.safeParse('').success).toBe(false)
    expect(formAnswerValueSchemas.choice.safeParse('not in the options').success).toBe(true)
  })

  it('requires an attachmentId uuid for attachment', () => {
    expect(
      formAnswerValueSchemas.attachment.safeParse({ attachmentId: '11111111-1111-1111-1111-111111111111' })
        .success,
    ).toBe(true)
    expect(formAnswerValueSchemas.attachment.safeParse({ attachmentId: 'nope' }).success).toBe(false)
    expect(formAnswerValueSchemas.attachment.safeParse('11111111-1111-1111-1111-111111111111').success).toBe(
      false,
    )
  })
})
