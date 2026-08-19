import { describe, expect, it } from 'vitest'
import { formStatusLine } from './formStatusLine.ts'

describe('formStatusLine', () => {
  // bot_active conversations sit in the unassigned queue, so an agent can open
  // a ticket while the player is still on question two. The line says so.
  it('counts progress while the player is still answering', () => {
    expect(formStatusLine('in_progress', 2, 4)).toBe('Player is answering · 2 of 4')
    expect(formStatusLine('in_progress', 0, 4)).toBe('Player is answering · 0 of 4')
  })

  it('reports a completed form', () => {
    expect(formStatusLine('completed', 4, 4)).toBe('All 4 questions answered')
    expect(formStatusLine('completed', 1, 1)).toBe('All 1 question answered')
  })

  // The spec's own phrasing for what the agent reads on a partial form.
  it('splits a partial form into answered and not', () => {
    expect(formStatusLine('partial', 2, 6)).toBe('2 answered · 4 not answered')
    expect(formStatusLine('partial', 3, 4)).toBe('3 answered · 1 not answered')
  })

  // A skipped form must read as a decision, not as an absence — the agent has
  // to know to ask rather than wonder where the details went.
  it('says the player skipped', () => {
    expect(formStatusLine('skipped', 0, 4)).toBe('Player skipped the questions')
  })
})
