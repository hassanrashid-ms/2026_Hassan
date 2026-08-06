import { describe, expect, it } from 'vitest'
import { toAgentView, toPlayerView } from '../src/domain/conversations/index.ts'
import type { PostedMessageRow } from '../src/domain/conversations/index.ts'

function row(overrides: Partial<PostedMessageRow> = {}): PostedMessageRow {
  return {
    id: 'm1',
    conversationId: 'c1',
    seq: 1,
    authorType: 'agent',
    authorAgentId: 'ag1',
    body: 'hello',
    visibility: 'public',
    deliveryState: 'sent',
    createdAt: new Date('2026-08-06T00:00:00Z'),
    ...overrides,
  }
}

describe('toPlayerView', () => {
  it('returns the whitelisted fields for a public message', () => {
    expect(toPlayerView(row())).toEqual({
      id: 'm1',
      seq: 1,
      author_type: 'agent',
      body: 'hello',
      delivery_state: 'sent',
      created_at: '2026-08-06T00:00:00.000Z',
    })
  })

  it('returns null for an internal message, guarding the serializer split even though this slice never writes internal itself', () => {
    expect(toPlayerView(row({ visibility: 'internal' }))).toBeNull()
  })
})

describe('toAgentView', () => {
  it('never returns null and includes visibility and author_agent_id', () => {
    expect(toAgentView(row({ visibility: 'internal' }))).toEqual({
      id: 'm1',
      seq: 1,
      author_type: 'agent',
      author_agent_id: 'ag1',
      body: 'hello',
      visibility: 'internal',
      delivery_state: 'sent',
      created_at: '2026-08-06T00:00:00.000Z',
    })
  })
})
