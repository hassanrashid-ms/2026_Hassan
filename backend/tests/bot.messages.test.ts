import { describe, expect, it } from 'vitest'
import { botFailureNote, HANDOFF_PLAYER_MESSAGE } from '../src/domain/bot/messages.ts'

describe('bot copy', () => {
  it('is the fixed player-facing handoff string', () => {
    expect(HANDOFF_PLAYER_MESSAGE).toBe("You're being connected to our support team.")
  })

  it('embeds the reason in the internal failure note', () => {
    expect(botFailureNote('error')).toBe('Bot could not respond (`error`). Handed off unclassified.')
    expect(botFailureNote('timeout')).toBe('Bot could not respond (`timeout`). Handed off unclassified.')
  })
})
