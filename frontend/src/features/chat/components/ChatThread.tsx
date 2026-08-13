import { Virtuoso } from 'react-virtuoso'
import { ArrowDown } from 'lucide-react'
import { DeliveryTicks } from './DeliveryTicks.tsx'
import { useJumpToLatest } from '../hooks/useJumpToLatest.ts'
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
  const { ref, showJump, missed, onAtBottomChange, jump } = useJumpToLatest(messages.length)

  return (
    // relative so the jump button can sit over the list; the wrapper takes the
    // height the caller gave this component and passes it straight through.
    <div className="relative h-full">
      <Virtuoso
        ref={ref}
        style={{ height: '100%' }}
        data={messages}
        atBottomStateChange={onAtBottomChange}
        // Generous enough that the few pixels a new bubble pushes the list by
        // don't read as "the reader scrolled away" and flash the button.
        atBottomThreshold={100}
        // Without these two the thread mounted scrolled to the *top*, which also
        // meant Virtuoso never considered itself at the bottom — so followOutput
        // had nothing to follow and new messages arrived off-screen. Callers
        // remount this per conversation (a `key`), which is what re-applies the
        // initial index when the agent switches threads.
        initialTopMostItemIndex={messages.length > 0 ? messages.length - 1 : 0}
        alignToBottom
        // A short spacer so the newest bubble never sits flush against whatever
        // the caller puts underneath — in the agent console, the composer.
        components={{ Footer: () => <div className="h-3" /> }}
        followOutput="auto"
        itemContent={(_index, chatMessage) => {
          const isOwn = chatMessage.authorType === currentAuthorType
          const isInternal = chatMessage.visibility === 'internal'

          // A third state, not a variant of the other two: a system message has no
          // side of the conversation to sit on, and rendering it as "not own" made
          // "Did this solve it?" indistinguishable from something the player
          // typed. Centred and unbubbled, so it reads as the transcript narrating
          // itself.
          if (chatMessage.authorType === 'system') {
            return (
              <div className="my-2 flex justify-center px-3" data-system="true">
                <p className="m-0 rounded-full border border-muted/20 bg-muted/10 px-3 py-1 text-center text-xs text-muted">
                  {chatMessage.body}
                  <time dateTime={chatMessage.createdAt} className="ml-2 opacity-70">
                    {new Date(chatMessage.createdAt).toLocaleTimeString()}
                  </time>
                </p>
              </div>
            )
          }

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

      {showJump && (
        <button
          type="button"
          onClick={jump}
          aria-label={missed > 0 ? `Jump to latest — ${missed} new` : 'Jump to latest'}
          className="absolute inset-x-0 bottom-3 mx-auto inline-flex w-fit items-center gap-1.5 rounded-full border border-muted/20 bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg shadow-md"
        >
          <ArrowDown className="size-3.5" />
          {missed > 0 ? `${missed} new message${missed === 1 ? '' : 's'}` : 'Jump to latest'}
        </button>
      )}
    </div>
  )
}
