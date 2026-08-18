import { describe, expect, it } from 'vitest'
import type { FormField } from '@support/types'
import { buildFormFieldViews } from '../src/agent/services/conversationContextService.ts'

const V1_FIELDS: FormField[] = [
  { key: 'store', label: 'Store', type: 'choice', isRequired: true, position: 0, options: ['Apple App Store', 'Google Play', 'Other'] },
  { key: 'order_or_receipt_id', label: 'Order or receipt ID', type: 'short_text', isRequired: true, position: 1 },
  { key: 'purchase_date', label: 'Date of purchase', type: 'date', isRequired: true, position: 2 },
  { key: 'what_you_expected', label: 'What you expected', type: 'long_text', isRequired: true, position: 3 },
]

describe('buildFormFieldViews', () => {
  it('renders every field in position order when all are answered', () => {
    const { rows, answeredCount } = buildFormFieldViews(V1_FIELDS, [
      { fieldKey: 'what_you_expected', fieldType: 'long_text', value: 'A refund' },
      { fieldKey: 'store', fieldType: 'choice', value: 'Google Play' },
      { fieldKey: 'purchase_date', fieldType: 'date', value: '2026-08-16' },
      { fieldKey: 'order_or_receipt_id', fieldType: 'short_text', value: 'GPA.1234' },
    ])

    expect(rows.map((r) => r.key)).toEqual(['store', 'order_or_receipt_id', 'purchase_date', 'what_you_expected'])
    expect(rows.every((r) => r.answered)).toBe(true)
    expect(answeredCount).toBe(4)
  })

  // The assertion that carries the product requirement: a gap is a row, not an
  // omission. An agent has to be able to tell "the player did not answer this"
  // from "this was never asked".
  it('keeps unanswered fields as rows rather than dropping them', () => {
    const { rows, answeredCount } = buildFormFieldViews(V1_FIELDS, [
      { fieldKey: 'store', fieldType: 'choice', value: 'Google Play' },
      { fieldKey: 'order_or_receipt_id', fieldType: 'short_text', value: 'GPA.1234' },
    ])

    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.answered)).toEqual([true, true, false, false])
    expect(rows[2]).toMatchObject({ key: 'purchase_date', label: 'Date of purchase', value: null, answered: false })
    expect(answeredCount).toBe(2)
  })

  it('renders every field as a gap when nothing was answered', () => {
    const { rows, answeredCount } = buildFormFieldViews(V1_FIELDS, [])
    expect(rows).toHaveLength(4)
    expect(rows.some((r) => r.answered)).toBe(false)
    expect(answeredCount).toBe(0)
  })

  // The answer snapshots its own field_type precisely so the value is
  // interpretable without resolving the version. A field retyped in v2 must not
  // change how a v1 answer reads.
  it('takes field_type from the answer, and only the label from the version', () => {
    const { rows } = buildFormFieldViews(
      [{ key: 'purchase_date', label: 'Date of purchase', type: 'short_text', isRequired: true, position: 0 }],
      [{ fieldKey: 'purchase_date', fieldType: 'date', value: '2026-08-16' }],
    )
    expect(rows[0]).toMatchObject({ label: 'Date of purchase', field_type: 'date', value: '2026-08-16' })
  })

  it('takes field_type from the version for an unanswered field', () => {
    const { rows } = buildFormFieldViews(
      [{ key: 'purchase_date', label: 'Date of purchase', type: 'date', isRequired: true, position: 0 }],
      [],
    )
    expect(rows[0]).toMatchObject({ field_type: 'date', answered: false })
  })

  it('sorts by position rather than trusting array order', () => {
    const { rows } = buildFormFieldViews(
      [
        { key: 'b', label: 'B', type: 'short_text', isRequired: false, position: 1 },
        { key: 'a', label: 'A', type: 'short_text', isRequired: false, position: 0 },
      ],
      [],
    )
    expect(rows.map((r) => r.key)).toEqual(['a', 'b'])
  })

  // Cannot normally occur — the answer route validates field_key against this
  // same version — but appending beats dropping, exactly as getPlayerStateView
  // does for a blob key with no declared_field row. answered_count stays on the
  // questions actually asked, so "2 of 4" never reads above its denominator.
  it('appends an answer whose key is not in the version, labelled by its key', () => {
    const { rows, answeredCount } = buildFormFieldViews(
      [{ key: 'a', label: 'A', type: 'short_text', isRequired: false, position: 0 }],
      [
        { fieldKey: 'a', fieldType: 'short_text', value: 'yes' },
        { fieldKey: 'ghost', fieldType: 'short_text', value: 'orphan' },
      ],
    )
    expect(rows.map((r) => r.key)).toEqual(['a', 'ghost'])
    expect(rows[1]).toMatchObject({ label: 'ghost', answered: true })
    expect(answeredCount).toBe(1)
  })
})
