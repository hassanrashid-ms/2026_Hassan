import { describe, expect, it } from 'vitest'
import { reconcilePending } from './chatReconcile.ts'
import type { ChatMessage } from '../components/types.ts'

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'server-1', authorType: 'player', body: 'hi', createdAt: '2026-08-06T00:00:00Z', ...overrides }
}

describe('reconcilePending', () => {
  it('keeps a pending message when no server message matches it yet', () => {
    const pending = [{ ...msg({ id: 'temp-1' }), tempId: 'temp-1' }]
    expect(reconcilePending([], pending)).toEqual([{ ...msg({ id: 'temp-1' }), tempId: 'temp-1' }])
  })

  it('drops a pending message once a matching server message arrives', () => {
    const pending = [{ ...msg({ id: 'temp-1' }), tempId: 'temp-1' }]
    const result = reconcilePending([msg()], pending)
    expect(result).toEqual([msg()])
  })

  it('does not drop a pending message with a different body', () => {
    const pending = [{ ...msg({ id: 'temp-1', body: 'different' }), tempId: 'temp-1' }]
    const result = reconcilePending([msg()], pending)
    expect(result).toEqual([msg(), { ...msg({ id: 'temp-1', body: 'different' }), tempId: 'temp-1' }])
  })
})
