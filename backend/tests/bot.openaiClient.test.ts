import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreate = vi.fn()
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mockCreate } }
  },
}))

import { callModel, ModelTimeoutError, ModelRefusalError } from '../src/domain/bot/openaiClient.ts'

describe('callModel', () => {
  // Not an implicit-return arrow (`() => mockCreate.mockReset()`): mockReset() returns the
  // mock itself, and returning it from a hook makes vitest's fake-timer-aware hook runner
  // treat it as a pending value to await, hanging the timeout test until hookTimeout (60s).
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it('returns tool calls from the response', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { tool_calls: [{ id: 't1', function: { name: 'search_articles', arguments: '{"query":"x"}' } }] } }],
    })
    const result = await callModel([{ role: 'user', content: 'hi' }], [])
    expect(result.toolCalls).toEqual([{ id: 't1', name: 'search_articles', arguments: '{"query":"x"}' }])
    expect(result.text).toBeNull()
  })

  it('returns text when there is no tool call', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'hello', tool_calls: undefined } }] })
    const result = await callModel([{ role: 'user', content: 'hi' }], [])
    expect(result.text).toBe('hello')
    expect(result.toolCalls).toEqual([])
  })

  it('throws ModelRefusalError on a refusal', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { refusal: 'cannot help', tool_calls: undefined, content: null } }] })
    await expect(callModel([], [])).rejects.toThrow(ModelRefusalError)
  })

  it('throws ModelTimeoutError when the call exceeds 15s', async () => {
    mockCreate.mockImplementation(() => new Promise(() => {})) // never resolves
    vi.useFakeTimers()
    const promise = callModel([], [])
    vi.advanceTimersByTime(15_001)
    await expect(promise).rejects.toThrow(ModelTimeoutError)
    vi.useRealTimers()
  })

  it('passes temperature 0 and the configured model', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'ok', tool_calls: undefined } }] })
    await callModel([], [])
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0, model: expect.any(String) }))
  })
})
