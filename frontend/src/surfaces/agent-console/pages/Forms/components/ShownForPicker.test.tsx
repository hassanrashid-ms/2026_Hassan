import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { IntentView } from '@support/types'
import { ShownForPicker, buildGroupedSubintents } from './ShownForPicker.tsx'

const INTENTS: IntentView[] = [
  {
    id: 'int-billing',
    name: 'Billing',
    subintents: [
      { id: 'sub-refund', name: 'Refund request', formId: null, archivedAt: null },
      { id: 'sub-payment', name: 'Payment failed', formId: null, archivedAt: null },
      { id: 'sub-cancel', name: 'Subscription cancel', formId: 'other-form', archivedAt: null },
      { id: 'sub-old', name: 'Old billing thing', formId: null, archivedAt: '2026-01-01T00:00:00Z' },
    ],
  },
  {
    id: 'int-account',
    name: 'Account Access',
    subintents: [
      { id: 'sub-pw', name: 'Password reset', formId: null, archivedAt: null },
      { id: 'sub-2fa', name: '2FA locked out', formId: null, archivedAt: null },
    ],
  },
]

describe('buildGroupedSubintents', () => {
  it('empty query returns every intent with all non-archived subintents', () => {
    const groups = buildGroupedSubintents(INTENTS, '', null)
    expect(groups.map((g) => g.id)).toEqual(['int-billing', 'int-account'])
    expect(groups[0]!.subintents.map((s) => s.id)).toEqual(['sub-refund', 'sub-payment', 'sub-cancel'])
  })

  it('never includes archived subintents', () => {
    const groups = buildGroupedSubintents(INTENTS, 'old', null)
    expect(groups).toEqual([])
  })

  it('matching intent name returns that intent with all its subintents', () => {
    const groups = buildGroupedSubintents(INTENTS, 'billing', null)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.subintents.map((s) => s.id)).toEqual(['sub-refund', 'sub-payment', 'sub-cancel'])
  })

  it('matching only a subintent name returns the parent intent with just that subintent', () => {
    const groups = buildGroupedSubintents(INTENTS, 'password', null)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.id).toBe('int-account')
    expect(groups[0]!.subintents.map((s) => s.id)).toEqual(['sub-pw'])
  })

  it('matching nothing returns an empty array', () => {
    expect(buildGroupedSubintents(INTENTS, 'nonexistent', null)).toEqual([])
  })

  it('locked is true only when formId is set and differs from currentFormId', () => {
    const groups = buildGroupedSubintents(INTENTS, '', 'other-form')
    const cancel = groups[0]!.subintents.find((s) => s.id === 'sub-cancel')!
    expect(cancel.locked).toBe(false)

    const groupsElsewhere = buildGroupedSubintents(INTENTS, '', 'some-other-form')
    const cancelLocked = groupsElsewhere[0]!.subintents.find((s) => s.id === 'sub-cancel')!
    expect(cancelLocked.locked).toBe(true)
  })

  it('bulkLocked is true if any subintent in the intent is locked, even when filtered out', () => {
    const groups = buildGroupedSubintents(INTENTS, 'refund', null)
    expect(groups[0]!.bulkLocked).toBe(true)
  })
})

describe('ShownForPicker', () => {
  it('removes a chip without opening the dialog', async () => {
    const onChange = vi.fn()
    render(
      <ShownForPicker
        intents={INTENTS}
        selected={['sub-pw']}
        onChange={onChange}
        currentFormId={null}
        disabled={false}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Remove Password reset' }))
    expect(onChange).toHaveBeenCalledWith([])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('checking an unlocked subintent in the dialog adds it to selected', async () => {
    const onChange = vi.fn()
    render(
      <ShownForPicker intents={INTENTS} selected={[]} onChange={onChange} currentFormId={null} disabled={false} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Add sub-intents' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Payment failed' }))
    expect(onChange).toHaveBeenCalledWith(['sub-payment'])
  })

  it('checking a locked subintent is a no-op', async () => {
    const onChange = vi.fn()
    render(
      <ShownForPicker intents={INTENTS} selected={[]} onChange={onChange} currentFormId={null} disabled={false} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Add sub-intents' }))
    const lockedCheckbox = screen.getByRole('checkbox', { name: 'Subscription cancelassigned' })
    expect(lockedCheckbox).toBeDisabled()
    await userEvent.click(lockedCheckbox)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('toggling an unlocked intent checkbox selects exactly its unlocked children', async () => {
    const onChange = vi.fn()
    render(
      <ShownForPicker intents={INTENTS} selected={[]} onChange={onChange} currentFormId={null} disabled={false} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Add sub-intents' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Account Access' }))
    expect(onChange).toHaveBeenCalledWith(['sub-pw', 'sub-2fa'])
  })

  it('an intent with one locked child disables its bulk checkbox while unlocked children stay checkable', async () => {
    const onChange = vi.fn()
    render(
      <ShownForPicker intents={INTENTS} selected={[]} onChange={onChange} currentFormId={null} disabled={false} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Add sub-intents' }))
    expect(screen.getByRole('checkbox', { name: /^Billing/ })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Refund request' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Payment failed' })).toBeEnabled()
  })
})
