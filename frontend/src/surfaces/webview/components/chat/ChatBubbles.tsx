import { Suspense } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { AlertCircle, ArrowDown, Bot, CircleUserRound, Headset } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DeliveryTicks } from '@/features/chat/components/DeliveryTicks'
import { useJumpToLatest } from '@/features/chat/hooks/useJumpToLatest'
import { MessageBody } from '@/features/chat/components/MessageBody'
import type { ChatMessage } from '@/features/chat/components/types'
import { cn } from '@/surfaces/webview/lib/cn'

/**
 * The webview's own thread renderer.
 *
 * features/chat/components/ChatThread.tsx is the agent console's renderer. Rather
 * than teach one shared component two visual languages, the webview hand-builds
 * its bubbles (as the design's component split calls for) and shares what
 * actually matters: the ChatMessage shape, reconcilePending, the socket, and the
 * API module. Behaviour is identical; only the pixels differ.
 *
 * Both renderers are plain Tailwind on the per-surface @theme tokens, so a
 * component written in `bg-surface`/`text-text` drops into either one. An earlier
 * version of this comment claimed ChatThread was styled by styles.css classes;
 * styles.css is a one-line deprecation notice and styles nothing at all.
 * See CLAUDE.md § Styling.
 *
 * followOutput="auto" sticks to the bottom on a new message but doesn't yank the
 * viewport if the reader has scrolled up to read history.
 */
export function ChatBubbles({
  messages,
  isTyping,
  onRetry,
}: {
  messages: ChatMessage[]
  isTyping?: boolean
  onRetry: (message: ChatMessage) => void
}) {
  const { ref, showJump, missed, onAtBottomChange, jump } = useJumpToLatest(messages.length)

  return (
    <div className="relative h-full">
      {/*
        One boundary for the whole thread, because MessageBody's ArticleBody is
        lazy: per-bubble boundaries would flash a fallback on every message as the
        list scrolls. `null` matches every other fallback in this surface — a
        spinner flashing over a paused game is worse than nothing. The list mounts
        fresh once the chunk resolves, which initialTopMostItemIndex and
        followOutput already put at the bottom.
      */}
      <Suspense fallback={null}>
        <Virtuoso
          ref={ref}
          style={{ height: '100%' }}
          data={messages}
          initialTopMostItemIndex={messages.length > 0 ? messages.length - 1 : 0}
          atBottomStateChange={onAtBottomChange}
          followOutput="auto"
          components={{
            Footer: () => isTyping ? (
              <div className="flex w-full px-4 py-1.5 justify-start">
                <div className="flex items-center rounded-card rounded-bl-sm bg-surface px-4 py-3 text-text">
                  <span className="flex gap-1">
                    <span className="size-1.5 animate-bounce rounded-full bg-muted"></span>
                    <span className="size-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: '150ms' }}></span>
                    <span className="size-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: '300ms' }}></span>
                  </span>
                  <span className="ml-2 text-sm text-muted font-medium">Bot is typing...</span>
                </div>
              </div>
            ) : null
          }}
          itemContent={(_index, message) => <ChatBubble message={message} onRetry={onRetry} />}
        />
      </Suspense>

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
  const isBot = message.authorType === 'bot' || message.authorType === 'system'

  return (
    <div className={cn('flex w-full px-4 py-1.5', own ? 'justify-end' : 'justify-start')}>
      <div className={cn('flex max-w-[85%] gap-2 items-start', own ? 'flex-row-reverse' : 'flex-row')}>
        {!own && (
          <div className="flex shrink-0 items-center justify-center mt-6">
            <span
              className={cn(
                'flex size-8 items-center justify-center rounded-full',
                isBot ? 'bg-muted/20' : message.authorType === 'agent' ? 'bg-accent/20' : 'bg-muted/20',
              )}
              aria-hidden="true"
            >
              {isBot ? <Bot className="size-5" /> : message.authorType === 'agent' ? <Headset className="size-5" /> : <CircleUserRound className="size-5" />}
            </span>
          </div>
        )}
        <div className={cn('flex flex-col gap-1', own ? 'items-end' : 'items-start')}>
          {!own && (
            <div className="mb-0.5 flex items-center gap-1.5 px-1 text-xs font-semibold opacity-75">
              <span className={message.authorType === 'player' ? 'break-all normal-case' : 'uppercase'}>
                {message.authorType === 'system' ? 'Support Bot' : (message.authorName ?? (isBot ? 'Support Bot' : message.authorType === 'agent' ? 'Agent' : 'You'))}
              </span>
            </div>
          )}
          <div
            className={cn(
              'rounded-card px-4 py-3 text-base leading-relaxed break-words',
              own
                ? 'rounded-br-sm bg-accent text-accent-fg'
                : 'rounded-bl-sm bg-surface text-text [&_code]:bg-bg [&_pre]:bg-bg',
              // A failed send stays legible rather than turning red-on-red; the
              // status line below carries the actual signal.
              failed && 'opacity-60',
              message.deliveryState === 'sending' && 'opacity-70',
            )}
          >
            <MessageBody authorType={message.authorType} body={message.body} />

            {/*
            Inside the same bubble, not a sibling block: a sibling with its own
            background reads as a second message. Client-appended, always —
            never model output. A prompt that asks for the link produces prose
            describing a link, which is the same failure mode CLAUDE.md
            documents for `handoff` and `answer_from_article`.

            A nested route, not the shared /embed/support/articles/:id: that one
            renders SupportHome, which would unmount a live chat and break the
            hardware back button.
          */}
          {!own && message.articleId && (
            <Link
              to={`/embed/support/chat/articles/${message.articleId}`}
              className="mt-2 inline-flex min-h-8 items-center border-t border-text/10 pt-2 text-sm font-semibold text-accent underline underline-offset-2"
            >
              Read more
            </Link>
          )}
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
    </div>
  )
}
