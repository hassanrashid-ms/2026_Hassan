import { Virtuoso } from 'react-virtuoso'
import { AlertCircle, ArrowDown } from 'lucide-react'
import { DeliveryTicks } from '@/features/chat/components/DeliveryTicks'
import { useJumpToLatest } from '@/features/chat/hooks/useJumpToLatest'
import type { ChatMessage } from '@/features/chat/components/types'
import { cn } from '@/surfaces/webview/lib/cn'

/**
 * The webview's own thread renderer.
 *
 * features/chat/components/ChatThread.tsx stays exactly as it is — the agent
 * console renders it, and it is styled by styles.css classes the webview no
 * longer loads. Rather than teach that shared component two visual languages, the
 * webview hand-builds its bubbles (as the design's component split calls for) and
 * shares what actually matters: the ChatMessage shape, reconcilePending, the
 * socket, and the API module. Behaviour is identical; only the pixels differ.
 *
 * followOutput="auto" sticks to the bottom on a new message but doesn't yank the
 * viewport if the reader has scrolled up to read history.
 */
export function ChatBubbles({
  messages,
  onRetry,
}: {
  messages: ChatMessage[]
  onRetry: (message: ChatMessage) => void
}) {
  const { ref, showJump, missed, onAtBottomChange, jump } = useJumpToLatest(messages.length)

  return (
    <div className="relative h-full">
      <Virtuoso
        ref={ref}
        style={{ height: '100%' }}
        data={messages}
        initialTopMostItemIndex={messages.length > 0 ? messages.length - 1 : 0}
        atBottomStateChange={onAtBottomChange}
        atBottomThreshold={100}
        followOutput="auto"
        itemContent={(_index, message) => <ChatBubble message={message} onRetry={onRetry} />}
      />

      {/* Touch-scale: a 32px pill is an agent-console affordance, not something
          a thumb finds on a phone. */}
      {showJump && (
        <button
          type="button"
          onClick={jump}
          aria-label={missed > 0 ? `Jump to latest — ${missed} new` : 'Jump to latest'}
          className="absolute inset-x-0 bottom-3 mx-auto inline-flex min-h-10 w-fit items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-accent-fg shadow-lg active:bg-accent-deep"
        >
          <ArrowDown className="size-4" />
          {missed > 0 ? `${missed} new message${missed === 1 ? '' : 's'}` : 'Jump to latest'}
        </button>
      )}
    </div>
  )
}

function ChatBubble({ message, onRetry }: { message: ChatMessage; onRetry: (message: ChatMessage) => void }) {
  const own = message.authorType === 'player'
  const failed = message.deliveryState === 'failed'

  return (
    <div className={cn('flex w-full px-4 py-1.5', own ? 'justify-end' : 'justify-start')}>
      <div className={cn('flex max-w-[80%] flex-col gap-1', own ? 'items-end' : 'items-start')}>
        <div
          className={cn(
            'rounded-card px-4 py-3 text-base leading-relaxed break-words',
            own
              ? 'rounded-br-sm bg-accent text-accent-fg'
              : 'rounded-bl-sm bg-surface text-text',
            // A failed send stays legible rather than turning red-on-red; the
            // status line below carries the actual signal.
            failed && 'opacity-60',
            message.deliveryState === 'sending' && 'opacity-70',
          )}
        >
          {message.body}
        </div>

        <div className="flex items-center gap-2 px-1 text-xs text-muted">
          <time dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
          {/* Default sky-500: this row sits on the page background, not on the accent bubble. */}
          {own && <DeliveryTicks deliveryState={message.deliveryState} />}
          {message.deliveryState === 'sending' && <span>Sending…</span>}
          {failed && (
            <span className="inline-flex items-center gap-1 text-accent">
              <AlertCircle className="size-3.5" />
              Not sent.
              <button type="button" onClick={() => onRetry(message)} className="font-semibold underline outline-none">
                Retry
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
