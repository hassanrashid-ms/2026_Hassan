import { beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ChatThread } from './ChatThread.tsx'
import type { ChatMessage } from './types.ts'

// jsdom never lays out real pixels and the global ResizeObserver stub never
// calls back, so Virtuoso's viewport measurement always reads 0 and it mounts
// no items. Give elements a non-zero size and fire the observer once so
// Virtuoso's measurement effect actually runs.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 600 })
  // jsdom never computes layout, so offsetParent is always null — Virtuoso's
  // resize callback bails out early on that check.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body })
  Element.prototype.getBoundingClientRect = () =>
    ({ width: 600, height: 600, top: 0, left: 0, right: 600, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect
  globalThis.ResizeObserver = class {
    callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }
    observe(target: Element) {
      this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    authorType: 'agent',
    body: 'hello',
    createdAt: '2026-08-11T10:42:00.000Z',
    deliveryState: 'read',
    visibility: 'public',
    ...overrides,
  }
}

describe('ChatThread read receipts', () => {
  it("shows Seen on the agent's own read message", async () => {
    render(
      <div style={{ height: 600 }}>
        <ChatThread messages={[message()]} currentAuthorType="agent" />
      </div>,
    )
    expect(await screen.findByText('Seen')).toBeInTheDocument()
  })

  it("shows Sent on the agent's own unread message", async () => {
    render(
      <div style={{ height: 600 }}>
        <ChatThread messages={[message({ deliveryState: 'sent' })]} currentAuthorType="agent" />
      </div>,
    )
    expect(await screen.findByText('Sent')).toBeInTheDocument()
  })

  it('never shows a receipt on an internal note, which no player can see', () => {
    render(
      <div style={{ height: 600 }}>
        <ChatThread messages={[message({ visibility: 'internal' })]} currentAuthorType="agent" />
      </div>,
    )
    expect(screen.queryByText('Seen')).not.toBeInTheDocument()
    expect(screen.queryByText('Sent')).not.toBeInTheDocument()
  })

  it('renders a system message as its own centred note, neither own nor not-own', async () => {
    render(
      <div style={{ height: 600 }}>
        <ChatThread messages={[message({ authorType: 'system', body: 'Did this solve it?' })]} currentAuthorType="agent" />
      </div>,
    )
    const note = await screen.findByText('Did this solve it?')
    // The two-state bubble tags every message it renders with data-own; a system
    // note has no side to be on, so it must not carry that attribute at all.
    expect(note.closest('[data-own]')).toBeNull()
    expect(note.closest('[data-system]')).not.toBeNull()
  })

  // Virtuoso sizes an item with getBoundingClientRect().height on its own
  // wrapper div, which has no padding or border — a vertical margin on the
  // element itemContent returns collapses through that wrapper and is measured
  // as zero. The list then thinks it is shorter than it renders, so the viewport
  // stops short of the real bottom (clipping the newest message) and atBottom
  // never becomes true, pinning the jump button on screen. jsdom computes no
  // layout, so the invariant is checked where it is expressed: the classnames.
  it('gives Virtuoso items no vertical margin, so their measured height is their real height', async () => {
    render(
      <div style={{ height: 600 }}>
        <ChatThread
          messages={[
            message({ id: 'a', authorType: 'agent', body: 'mine' }),
            message({ id: 'b', authorType: 'player', body: 'theirs' }),
            message({ id: 'c', authorType: 'system', body: 'Did this solve it?' }),
          ]}
          currentAuthorType="agent"
        />
      </div>,
    )
    await screen.findByText('mine')
    const items = document.querySelectorAll('[data-index]')
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      const root = item.firstElementChild
      expect(root, 'every rendered item has a root element').not.toBeNull()
      expect(root!.className).not.toMatch(/(^|\s)-?m[ytb]-/)
    }
  })

  it("never shows a receipt on the other side's message", () => {
    render(
      <div style={{ height: 600 }}>
        <ChatThread messages={[message({ authorType: 'player' })]} currentAuthorType="agent" />
      </div>,
    )
    expect(screen.queryByText('Seen')).not.toBeInTheDocument()
  })

  /**
   * Bot and player both arrive at the agent console as "not own" and used to
   * render as the same bubble on the same side, so an agent reading a thread
   * could not tell which of the two had spoken — a bot's reply read as the
   * player's own words.
   */
  // Rendered one at a time on purpose: jsdom computes no layout, so Virtuoso
  // mounts only the first item of a list and a two-message thread would assert
  // against a bubble that was never in the DOM.
  it('labels a bot message as Bot', async () => {
    render(
      <div style={{ height: 600 }}>
        <ChatThread messages={[message({ id: 'b', authorType: 'bot', body: 'from the bot' })]} currentAuthorType="agent" />
      </div>,
    )
    await screen.findByText('from the bot')
    expect(screen.getByText('Bot')).toBeInTheDocument()
  })

  /**
   * The bot answers on support's behalf. Rendered opposite the agent's own
   * replies it reads as something the player said, which is the confusion this
   * whole labelling exists to end — a side is a stronger signal than a badge.
   */
  it('puts a bot message on the agent\'s own side, while still not counting as "own"', async () => {
    render(
      <div style={{ height: 600 }}>
        <ChatThread messages={[message({ id: 'b', authorType: 'bot', body: 'from the bot' })]} currentAuthorType="agent" />
      </div>,
    )
    await screen.findByText('from the bot')
    const bot = document.querySelector('[data-author="bot"]')!
    expect(bot.getAttribute('data-own-side')).toBe('true')
    // Not "own": the agent did not type it, so it must not claim a read receipt.
    expect(bot.getAttribute('data-own')).toBe('false')
    expect(bot.className).toContain('ml-auto')
    expect(screen.queryByText('Seen')).not.toBeInTheDocument()
  })

  it('names the player on their bubbles when the caller supplies an id, instead of the generic word', async () => {
    render(
      <div style={{ height: 600 }}>
        <ChatThread
          messages={[message({ id: 'p', authorType: 'player', body: 'from the player' })]}
          currentAuthorType="agent"
          playerLabel="UserId7661"
        />
      </div>,
    )
    await screen.findByText('from the player')
    expect(screen.getByText('UserId7661')).toBeInTheDocument()
    expect(screen.queryByText('Player')).not.toBeInTheDocument()
  })

  it('falls back to Player when no id has resolved yet, so a bubble is never unlabelled', async () => {
    render(
      <div style={{ height: 600 }}>
        <ChatThread messages={[message({ id: 'p', authorType: 'player', body: 'from the player' })]} currentAuthorType="agent" />
      </div>,
    )
    await screen.findByText('from the player')
    expect(screen.getByText('Player')).toBeInTheDocument()
  })

  it('keeps the bot on the player-facing side when the reader is the player', async () => {
    render(
      <div style={{ height: 600 }}>
        <ChatThread messages={[message({ id: 'b', authorType: 'bot', body: 'from the bot' })]} currentAuthorType="player" />
      </div>,
    )
    await screen.findByText('from the bot')
    const bot = document.querySelector('[data-author="bot"]')!
    expect(bot.getAttribute('data-own-side')).toBe('false')
    expect(bot.className).toContain('mr-auto')
  })

  it('labels a player message as Player, and styles it differently from a bot message', async () => {
    const { unmount } = render(
      <div style={{ height: 600 }}>
        <ChatThread messages={[message({ id: 'p', authorType: 'player', body: 'from the player' })]} currentAuthorType="agent" />
      </div>,
    )
    await screen.findByText('from the player')
    expect(screen.getByText('Player')).toBeInTheDocument()
    const playerBubble = document.querySelector('[data-author="player"]')!
    const playerClass = playerBubble.className
    expect(playerClass).toContain('mr-auto')
    unmount()


    render(
      <div style={{ height: 600 }}>
        <ChatThread messages={[message({ id: 'b', authorType: 'bot', body: 'from the bot' })]} currentAuthorType="agent" />
      </div>,
    )
    await screen.findByText('from the bot')
    // Distinguishable without reading the label, too.
    expect(document.querySelector('[data-author="bot"]')!.className).not.toBe(playerClass)
  })

  it('does not label the reading agent\'s own messages — "own" is already the side it sits on', async () => {
    render(
      <div style={{ height: 600 }}>
        <ChatThread messages={[message({ authorType: 'agent', body: 'mine' })]} currentAuthorType="agent" />
      </div>,
    )
    await screen.findByText('mine')
    expect(screen.queryByText('Agent')).not.toBeInTheDocument()
  })
})

describe('ChatThread article delivery', () => {
  it('renders a bot body as markdown', async () => {
    const { container } = render(
      <ChatThread messages={[message({ authorType: 'bot', body: 'Refunds take **48 hours**.' })]} currentAuthorType="agent" />,
    )

    await waitFor(() => expect(container.querySelector('strong')?.textContent).toBe('48 hours'))
    expect(container.textContent).not.toContain('**')
  })

  it('renders a player body literally', async () => {
    const { container } = render(
      <ChatThread messages={[message({ authorType: 'player', body: 'my **game** crashed' })]} currentAuthorType="agent" />,
    )

    await waitFor(() => expect(screen.getByText('my **game** crashed')).toBeInTheDocument())
    expect(container.querySelector('strong')).toBeNull()
  })

  it('opens the cited article in a new tab, so the conversation stays on screen', async () => {
    render(
      <ChatThread messages={[message({ authorType: 'bot', body: 'answer', articleId: 'art-1' })]} currentAuthorType="agent" />,
    )

    const link = await screen.findByRole('link', { name: 'Read more' })
    expect(link).toHaveAttribute('href', '/articles/art-1')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders no button when nothing was cited', async () => {
    render(<ChatThread messages={[message({ authorType: 'bot', body: 'answer' })]} currentAuthorType="agent" />)

    await waitFor(() => expect(screen.getByText('answer')).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: 'Read more' })).not.toBeInTheDocument()
  })
})
