import { describe, expect, it } from 'vitest'
import { RenameIntentBody, RenameSubintentBody, MoveSubintentBody, MergeSubintentBody } from '../src/index.ts'

describe('RenameIntentBody', () => {
  it('accepts a well-formed name', () => {
    expect(RenameIntentBody.safeParse({ name: 'Billing' }).success).toBe(true)
  })
  it('rejects an empty name', () => {
    expect(RenameIntentBody.safeParse({ name: '' }).success).toBe(false)
  })
})

describe('RenameSubintentBody', () => {
  it('accepts name only', () => {
    expect(RenameSubintentBody.safeParse({ name: 'Refunds' }).success).toBe(true)
  })
  it('accepts defaultPriority only', () => {
    expect(RenameSubintentBody.safeParse({ defaultPriority: 'p2' }).success).toBe(true)
  })
  it('accepts both', () => {
    expect(RenameSubintentBody.safeParse({ name: 'Refunds', defaultPriority: 'p1' }).success).toBe(true)
  })
  it('accepts an empty body — the endpoint allows a no-op patch', () => {
    expect(RenameSubintentBody.safeParse({}).success).toBe(true)
  })
  it('rejects an invalid priority', () => {
    expect(RenameSubintentBody.safeParse({ defaultPriority: 'p9' }).success).toBe(false)
  })
})

describe('MoveSubintentBody', () => {
  it('requires a uuid intentId', () => {
    expect(MoveSubintentBody.safeParse({ intentId: 'not-a-uuid' }).success).toBe(false)
    expect(MoveSubintentBody.safeParse({ intentId: '11111111-1111-1111-1111-111111111111' }).success).toBe(true)
  })
})

describe('MergeSubintentBody', () => {
  it('requires a uuid intoId', () => {
    expect(MergeSubintentBody.safeParse({ intoId: 'nope' }).success).toBe(false)
    expect(MergeSubintentBody.safeParse({ intoId: '11111111-1111-1111-1111-111111111111' }).success).toBe(true)
  })
})
