import { Virtuoso } from 'react-virtuoso'
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
 */
export function ChatThread({ messages, currentAuthorType, onRetry }: ChatThreadProps) {
  return (
    <Virtuoso
      style={{ height: '100%' }}
      data={messages}
      followOutput="auto"
      itemContent={(_index, chatMessage) => (
        <div
          className={`chat-message chat-message--${chatMessage.authorType}`}
          data-own={chatMessage.authorType === currentAuthorType}
        >
          <p>{chatMessage.body}</p>
          <time dateTime={chatMessage.createdAt}>{new Date(chatMessage.createdAt).toLocaleTimeString()}</time>
          {chatMessage.deliveryState === 'sending' && <span className="chat-message__status">Sending…</span>}
          {chatMessage.deliveryState === 'failed' && (
            <span className="chat-message__status">
              Failed to send.{' '}
              <button type="button" onClick={() => onRetry?.(chatMessage)}>
                Retry
              </button>
            </span>
          )}
        </div>
      )}
    />
  )
}
