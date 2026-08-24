import { Suspense } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { ArrowDown, Bot, CircleUserRound, Headset } from 'lucide-react';
import { DeliveryTicks } from './DeliveryTicks.tsx';
import { MessageBody } from './MessageBody.tsx';
import { useJumpToLatest } from '../hooks/useJumpToLatest.ts';
import type { ChatAuthorType, ChatMessage } from './types.ts';

type ChatThreadProps = {
  messages: ChatMessage[];
  currentAuthorType: ChatAuthorType;
  /** Only ever called for a message with deliveryState 'failed'. Omit only if the caller renders no optimistic sends at all — both surfaces do. */
  onRetry?: (message: ChatMessage) => void;
  /**
   * What to call the player on their bubbles — the agent console passes the
   * `external_player_id`, which is the only identity a player has (there is no
   * display name on `player`). Falls back to the generic word when the caller
   * has not resolved one yet, so a bubble is never left unlabelled mid-load.
   */
  playerLabel?: string;
};

/**
 * followOutput="auto" sticks to the bottom on a new message but doesn't yank
 * the viewport if the reader has scrolled up to read history.
 *
 * Styled with bare Tailwind utilities against the --color-accent/--color-muted
 * tokens rather than a semantic classname — this component is shared, and each
 * surface (agent-console, webview) defines those tokens differently in its own
 * scoped stylesheet. A hand-written CSS rule here would apply to whichever
 * surface's global stylesheet loaded last, not the one actually rendering it.
 *
 * Never put a vertical margin on what itemContent returns. Virtuoso sizes each
 * item with `getBoundingClientRect().height` on its own wrapper div, which has
 * no padding or border — so a `my-*` on the returned element collapses straight
 * through the wrapper and is measured as zero. The list then believes it is
 * shorter than it renders, and the gap accumulates per message: the viewport
 * stops a few pixels per message short of the real bottom, clipping the newest
 * bubble and leaving atBottom permanently false, which is what pins the "jump to
 * latest" button on screen. Space items with padding on a wrapper instead.
 */
export function ChatThread({ messages, currentAuthorType, onRetry, playerLabel }: ChatThreadProps) {
  const { ref, showJump, missed, onAtBottomChange, jump } = useJumpToLatest(messages.length);

  return (
    // relative so the jump button can sit over the list; the wrapper takes the
    // height the caller gave this component and passes it straight through.
    <div className="relative h-full">
      {/* One boundary for the whole thread: MessageBody's ArticleBody is lazy,
          and a per-bubble boundary would flash a fallback on every message as
          the list scrolls. Same reasoning as the webview's ChatBubbles. */}
      <Suspense fallback={null}>
        <Virtuoso
          ref={ref}
          style={{ height: '100%' }}
          data={messages}
          atBottomStateChange={onAtBottomChange}
          // Deliberately the same Virtuoso configuration as the webview's
          // ChatBubbles, which has always behaved correctly. `alignToBottom` and a
          // manual scrollToIndex on send were tried here and both misplaced the
          // viewport — Virtuoso measures a bubble after it renders, so scrolling
          // to one in the same commit lands on its stale height, mid-message.
          // followOutput does its own scrolling after measurement; leave it to it.
          // Callers remount this per conversation (a `key`), which re-applies the
          // initial index when the agent switches threads.
          //
          // A bare index, not the `{ index: 'LAST', align: 'end' }` form that
          // reads better: an aligned initial location keeps the whole list at
          // `visibility: hidden` until Virtuoso reports that location reached,
          // and on a list that mounts empty — which this one does for the frame
          // before the messages query resolves — that never happens and nothing
          // renders at all. The bare index relies on the browser clamping the
          // scroll to the bottom, which is exact now that item heights measure
          // correctly.
          initialTopMostItemIndex={messages.length > 0 ? messages.length - 1 : 0}
          // A short spacer so the newest bubble never sits flush against whatever
          // the caller puts underneath — in the agent console, the composer.
          components={{ Footer: () => <div className="h-3" /> }}
          followOutput="auto"
          itemContent={(_index, chatMessage) => {
            const isOwn = chatMessage.authorType === currentAuthorType;
            const isInternal = chatMessage.visibility === 'internal';
            const isBot = chatMessage.authorType === 'bot' || chatMessage.authorType === 'system';

            // The bot answers on support's behalf, so to an agent it is not the
            // other party — it is their own side of the thread, and reading it
            // opposite the agent's replies misrepresents who the player is talking
            // to. To a player it stays the counterparty, which is why this is
            // conditioned on who is reading rather than being a property of the
            // message. `isOwn` still means "I typed this" and keeps driving the
            // receipt below; only the side is widened.
            const onOwnSide = isOwn || (isBot && currentAuthorType === 'agent');

            return (
              // Only the gap between bubbles moves to the wrapper, and only as
              // padding — that is the whole of what Virtuoso mismeasures. The
              // bubble keeps its own block layout: `mx-3` with `ml-auto`/`mr-auto`
              // against `max-w-[82%]` gives every bubble the same 82% width and
              // lets the leftover margin pick the side. Making it a flex item
              // instead would silently switch that to shrink-to-fit, so short
              // messages would stop matching long ones. Horizontal margins don't
              // affect item height, so they can stay exactly where they were.
              <div
                className={[
                  'flex w-full px-3 py-1',
                  onOwnSide ? 'justify-end' : 'justify-start',
                ].join(' ')}
              >
                <div
                  className={[
                    'flex max-w-[82%] gap-2 items-start',
                    onOwnSide ? 'flex-row-reverse' : 'flex-row',
                  ].join(' ')}
                >
                  <div className="flex shrink-0 items-center justify-center mt-6">
                    <span
                      className={[
                        'flex size-8 items-center justify-center rounded-full',
                        isBot
                          ? 'bg-muted/20'
                          : chatMessage.authorType === 'agent'
                            ? 'bg-accent-deep/20'
                            : 'bg-muted/20',
                      ].join(' ')}
                      aria-hidden="true"
                    >
                      {isBot ? (
                        <Bot className="size-5" />
                      ) : chatMessage.authorType === 'agent' ? (
                        <Headset className="size-5" />
                      ) : (
                        <CircleUserRound className="size-5" />
                      )}
                    </span>
                  </div>
                  <div
                    className={[
                      'rounded-2xl px-3 py-2 text-sm leading-snug break-words shadow-sm',
                      // Side is "whose side of the conversation", not "who typed it"
                      // — kept separate from the colour below so the bot can sit on
                      // support's side without also borrowing the agent's styling.
                      onOwnSide ? 'rounded-br-sm' : 'rounded-bl-sm',
                      isOwn
                        ? 'bg-accent text-accent-fg'
                        : 'border border-muted/20 bg-accent-soft text-text',
                      // The bot shares a side with the agent now, so the label is no
                      // longer the only thing separating them — this keeps them
                      // distinguishable at a glance, without reading.
                      isBot ? 'border-dashed border-muted/50 bg-muted/10' : null,
                      isInternal ? 'border border-amber-500 bg-amber-100 text-amber-900' : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    data-own={isOwn}
                    data-own-side={onOwnSide}
                    data-author={chatMessage.authorType}
                  >
                    <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold opacity-75">
                      <span
                        className={
                          chatMessage.authorType === 'player'
                            ? 'break-all normal-case'
                            : 'uppercase'
                        }
                      >
                        {chatMessage.authorType === 'system'
                          ? 'Support Bot'
                          : (chatMessage.authorName ??
                            (isBot
                              ? 'Support Bot'
                              : chatMessage.authorType === 'agent'
                                ? 'Agent'
                                : (playerLabel ?? 'Player')))}
                      </span>
                    </div>
                    {/* `agent` renders as markdown too, so article steps an agent
                      pasted read exactly like the bot's own answer. */}
                    <div className="m-0">
                      {/* dark only for a genuinely-own bubble: that's the only one styled
                        bg-accent text-accent-fg above. The bot's own-side bubble stays on
                        the light bg-muted/10 and keeps the default dark article text. */}
                      <MessageBody
                        authorType={chatMessage.authorType}
                        body={chatMessage.body}
                        attachment={chatMessage.attachment}
                        dark={isOwn}
                      />
                    </div>
                    <time
                      dateTime={chatMessage.createdAt}
                      className="mt-1 block text-xs opacity-80"
                    >
                      {new Date(chatMessage.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                    {/*
                  A plain anchor in a new tab, not in-app navigation: routing the
                  console to the article would hijack the conversation the agent
                  is reading. Client-appended from articleId — the model is never
                  asked to write a link.
                */}
                    {chatMessage.articleId && (
                      <a
                        href={`/articles/${chatMessage.articleId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center rounded-md border border-muted/30 px-2 py-0.5 text-xs font-medium underline underline-offset-2"
                      >
                        Read more
                      </a>
                    )}
                    {/* Never on an internal note: the player cannot see the message, so
                    any receipt would be a claim about something they never got. */}
                    {isOwn && !isInternal && (
                      <span className="mt-0.5 block text-xs">
                        {/* sky-300, not the default sky-500: an own bubble here is slate-600, and the darker blue disappears against it. */}
                        <DeliveryTicks
                          deliveryState={chatMessage.deliveryState}
                          readClassName="text-sky-300"
                        />
                      </span>
                    )}
                    {chatMessage.deliveryState === 'sending' && (
                      <span className="mt-0.5 block text-xs opacity-80">Sending…</span>
                    )}
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
                </div>
              </div>
            );
          }}
        />
      </Suspense>

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
  );
}
