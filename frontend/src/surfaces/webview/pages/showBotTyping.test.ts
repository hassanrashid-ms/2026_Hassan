import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/features/chat/components/types'
import { showBotTyping } from './showBotTyping.ts'

function playerMessage(deliveryState: ChatMessage['deliveryState']): ChatMessage {
  return {
    id: 'm1',
    authorType: 'player',
    body: 'still broken',
    createdAt: '2026-08-18T10:00:00.000Z',
    deliveryState,
  }
}

const BOT_ACTIVE = { status: 'bot_active', settled: false, confirmPending: false, hasActiveForm: false }

describe('showBotTyping', () => {
  // The bug this function exists for: the optimistic bubble lands on the click,
  // so the indicator used to appear before the POST had left the device.
  it('stays quiet while the player message is still in flight', () => {
    expect(showBotTyping({ ...BOT_ACTIVE, lastMessage: playerMessage('sending') })).toBe(false)
  })

  it('stays quiet when the send failed outright', () => {
    // A message the server never saw cannot be one the bot is answering.
    expect(showBotTyping({ ...BOT_ACTIVE, lastMessage: playerMessage('failed') })).toBe(false)
  })

  it('shows once the send has been accepted', () => {
    expect(showBotTyping({ ...BOT_ACTIVE, lastMessage: playerMessage('sent') })).toBe(true)
    expect(showBotTyping({ ...BOT_ACTIVE, lastMessage: playerMessage('delivered') })).toBe(true)
    expect(showBotTyping({ ...BOT_ACTIVE, lastMessage: playerMessage('read') })).toBe(true)
  })

  it('shows for a server message carrying no delivery state at all', () => {
    expect(showBotTyping({ ...BOT_ACTIVE, lastMessage: playerMessage(undefined) })).toBe(true)
  })

  it('stays quiet when the bot already replied', () => {
    expect(
      showBotTyping({ ...BOT_ACTIVE, lastMessage: { ...playerMessage('read'), authorType: 'bot' } }),
    ).toBe(false)
  })

  it('stays quiet on an empty thread', () => {
    expect(showBotTyping({ ...BOT_ACTIVE, lastMessage: undefined })).toBe(false)
  })

  // Pre-existing conditions, kept so the extraction cannot quietly drop one.
  it('stays quiet when a human owns the conversation', () => {
    expect(showBotTyping({ ...BOT_ACTIVE, status: 'open', lastMessage: playerMessage('read') })).toBe(false)
  })

  it('stays quiet while a banner or a form is waiting on the player', () => {
    const sent = playerMessage('read')
    expect(showBotTyping({ ...BOT_ACTIVE, settled: true, lastMessage: sent })).toBe(false)
    expect(showBotTyping({ ...BOT_ACTIVE, confirmPending: true, lastMessage: sent })).toBe(false)
    expect(showBotTyping({ ...BOT_ACTIVE, hasActiveForm: true, lastMessage: sent })).toBe(false)
  })
})
