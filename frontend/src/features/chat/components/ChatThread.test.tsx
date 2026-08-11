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

  it("never shows a receipt on the other side's message", () => {
    render(
      <div style={{ height: 600 }}>
        <ChatThread messages={[message({ authorType: 'player' })]} currentAuthorType="agent" />
      </div>,
    )
    expect(screen.queryByText('Seen')).not.toBeInTheDocument()
  })
})
