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
    readAt: null,
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
      read_at: null,
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
      read_at: null,
      created_at: '2026-08-06T00:00:00.000Z',
    })
  })
})

describe('read_at serialization', () => {
  it('serializes a read timestamp as an ISO string in both views', () => {
    const read = row({ deliveryState: 'read', readAt: new Date('2026-08-11T10:43:07Z') })
    expect(toPlayerView(read)?.read_at).toBe('2026-08-11T10:43:07.000Z')
    expect(toAgentView(read).read_at).toBe('2026-08-11T10:43:07.000Z')
  })

  it('serializes an unread message as null, not undefined or an empty string', () => {
    expect(toPlayerView(row())?.read_at).toBeNull()
    expect(toAgentView(row()).read_at).toBeNull()
  })
})
