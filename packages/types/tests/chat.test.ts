import { describe, expect, it } from 'vitest'
import { MarkAgentReadBody, MarkPlayerReadBody, SendAgentMessageBody, SendMessageBody } from '../src/chat.ts'

describe('chat request schemas', () => {
  it('SendMessageBody accepts a non-empty body', () => {
    expect(SendMessageBody.safeParse({ body: 'hello' }).success).toBe(true)
  })

  it('SendMessageBody rejects an empty body', () => {
    expect(SendMessageBody.safeParse({ body: '' }).success).toBe(false)
  })

  it('SendAgentMessageBody requires a uuid conversation_id', () => {
    expect(SendAgentMessageBody.safeParse({ conversation_id: 'not-a-uuid', body: 'hi' }).success).toBe(false)
    expect(
      SendAgentMessageBody.safeParse({ conversation_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', body: 'hi' })
        .success,
    ).toBe(true)
  })

  it('MarkPlayerReadBody requires a non-negative integer', () => {
    expect(MarkPlayerReadBody.safeParse({ up_to_seq: -1 }).success).toBe(false)
    expect(MarkPlayerReadBody.safeParse({ up_to_seq: 1.5 }).success).toBe(false)
    expect(MarkPlayerReadBody.safeParse({ up_to_seq: 3 }).success).toBe(true)
  })

  it('MarkAgentReadBody requires both fields', () => {
    expect(MarkAgentReadBody.safeParse({ up_to_seq: 3 }).success).toBe(false)
  })
})
