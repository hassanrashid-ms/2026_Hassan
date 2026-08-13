import { beforeAll, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
