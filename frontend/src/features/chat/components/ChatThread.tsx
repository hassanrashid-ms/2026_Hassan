import { Virtuoso } from 'react-virtuoso'
import { DeliveryTicks } from './DeliveryTicks.tsx'
import type { ChatAuthorType, ChatMessage } from './types.ts'

type ChatThreadProps = {
  messages: ChatMessage[]
  currentAuthorType: ChatAuthorType
  /** Only ever called for a message with deliveryState 'failed'. Omit if the caller has no pending/optimistic sends to retry (e.g. the agent console, which never renders a 'sending' or 'failed' message). */
  onRetry?: (message: ChatMessage) => void
}

/**
 * followOutput="auto" sticks to the bottom on a new message but doesn't yank
 * the viewport if the reader has scrolled up to read history.
 *
 * Styled with bare Tailwind utilities against the --color-accent/--color-muted
 * tokens rather than a semantic classname — this component is shared, and each
 * surface (agent-console, webview) defines those tokens differently in its own
 * scoped stylesheet. A hand-written CSS rule here would apply to whichever
 * surface's global stylesheet loaded last, not the one actually rendering it.
 */
export function ChatThread({ messages, currentAuthorType, onRetry }: ChatThreadProps) {
  return (
    <Virtuoso
      style={{ height: '100%' }}
      data={messages}
      followOutput="auto"
      itemContent={(_index, chatMessage) => {
        const isOwn = chatMessage.authorType === currentAuthorType
        const isInternal = chatMessage.visibility === 'internal'
        return (
          <div
            className={[
              'mx-3 my-1 max-w-[82%] rounded-2xl px-3 py-2 text-sm leading-snug break-words shadow-sm',
              isOwn ? 'ml-auto rounded-br-sm bg-accent text-accent-fg' : 'mr-auto rounded-bl-sm border border-muted/20 bg-accent-soft text-text',
              isInternal ? 'border border-amber-500 bg-amber-100 text-amber-900' : null,
            ]
              .filter(Boolean)
              .join(' ')}
            data-own={isOwn}
          >
            <p className="m-0">{chatMessage.body}</p>
            <time dateTime={chatMessage.createdAt} className="mt-1 block text-xs opacity-80">
              {new Date(chatMessage.createdAt).toLocaleTimeString()}
            </time>
            {/* Never on an internal note: the player cannot see the message, so
                any receipt would be a claim about something they never got. */}
            {isOwn && !isInternal && (
              <span className="mt-0.5 block text-xs">
                {/* sky-300, not the default sky-500: an own bubble here is slate-600, and the darker blue disappears against it. */}
                <DeliveryTicks deliveryState={chatMessage.deliveryState} readClassName="text-sky-300" />
              </span>
            )}
            {chatMessage.deliveryState === 'sending' && <span className="mt-0.5 block text-xs opacity-80">Sending…</span>}
            {chatMessage.deliveryState === 'failed' && (
              <span className="mt-0.5 block text-xs opacity-80">
                Failed to send.{' '}
                <button
                  type="button"
                  className="ml-1 rounded bg-red-500 px-1.5 py-0.5 text-xs text-white hover:bg-red-600"
                  onClick={() => onRetry?.(chatMessage)}
                >
                  Retry
                </button>
              </span>
            )}
          </div>
        )
      }}
    />
  )
}
