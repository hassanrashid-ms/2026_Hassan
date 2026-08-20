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
    articleId: null,
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
      author_name: 'Agent',
      body: 'hello',
      delivery_state: 'sent',
      read_at: null,
      created_at: '2026-08-06T00:00:00.000Z',
      article_id: null,
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
      author_name: 'Agent',
      author_agent_id: 'ag1',
      body: 'hello',
      visibility: 'internal',
      delivery_state: 'sent',
      read_at: null,
      created_at: '2026-08-06T00:00:00.000Z',
      article_id: null,
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

describe('article_id on both views', () => {
  it('carries a cited article to the player', () => {
    expect(toPlayerView(row({ authorType: 'bot', articleId: 'art-1' }))?.article_id).toBe('art-1')
  })

  it('carries a cited article to the agent', () => {
    expect(toAgentView(row({ authorType: 'bot', articleId: 'art-1' })).article_id).toBe('art-1')
  })

  it('is null on a message that cited nothing — which is every pre-existing message', () => {
    expect(toPlayerView(row())?.article_id).toBeNull()
    expect(toAgentView(row()).article_id).toBeNull()
  })

  /**
   * The whitelist still decides the whole row, not per-field: an internal note
   * with an article on it must not leak the article either.
   */
  it('still returns null for an internal message, article or not', () => {
    expect(toPlayerView(row({ visibility: 'internal', articleId: 'art-1' }))).toBeNull()
  })
})
