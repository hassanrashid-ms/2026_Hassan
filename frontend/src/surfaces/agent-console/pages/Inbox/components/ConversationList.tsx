import { useEffect } from 'react';
import type { AgentConversationsResponse, ConversationStatusValue } from '@support/types';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { fetchInbox } from '../../../api/agentApi.ts';
import { createSocket } from '../../../../../features/chat/api/socket.ts';
import { handleSessionExpired } from '../../../lib/authErrorHandling.ts';
import { ScrollArea } from '../../../components/ui/scroll-area.tsx';
import { EmptyState } from '../../../components/ui/empty-state.tsx';
import { ConversationRow } from './ConversationRow.tsx';

type InboxPages = { pages: AgentConversationsResponse[]; pageParams: (string | undefined)[] };

// Each queue scrolls independently, capped to roughly five rows tall — a
// queue with many pages loaded no longer pushes the other queue's header
// out of reach, and no longer re-triggers the other queue's pagination just
// because the user is scrolled near the bottom of this one.
//
// A fixed height, not max-height: Radix's ScrollArea needs a determinate
// height on Root to compute the Viewport's overflow against. max-height only
// clips — Root still sizes to its (shorter) content, the Viewport never
// becomes taller than its content, and nothing ever registers as
// scrollable, even once more rows are loaded than fit.
const QUEUE_HEIGHT = 'h-[26rem]';
// ConversationRow is ~88px tall (py-3.5 + three text lines) — roughly what
// fits in QUEUE_HEIGHT before the queue actually scrolls. Below this count,
// the fixed height would just be empty space, so the queue is left unsized
// (shrinks to its content) instead.
const ROWS_BEFORE_SCROLLING = 4;

function ConversationQueue({
  title,
  testId,
  conversations,
  selectedId,
  onSelect,
  emptyLabel,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  title: string;
  testId: string;
  conversations: AgentConversationsResponse['conversations'];
  selectedId: string | null;
  onSelect: (id: string) => void;
  emptyLabel: string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}) {
  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (!nearBottom) return;
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }

  // More loaded than fits, or more still to fetch — either way, this queue
  // needs its fixed height to actually scroll. Short of that, leave it
  // unsized so it doesn't sit in a box with empty space below it.
  const scrollable = conversations.length > ROWS_BEFORE_SCROLLING || hasNextPage;

  return (
    <div className="flex shrink-0 flex-col border-b border-slate-100">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-surface px-3 py-2 text-sm font-semibold">
        {title}
        <span className="rounded-full bg-muted/15 px-1.5 py-0.5 text-xs font-medium text-muted">
          {conversations.length}
        </span>
      </div>
      <div className="relative">
        <ScrollArea
          className={scrollable ? QUEUE_HEIGHT : undefined}
          viewportTestId={testId}
          onScroll={handleScroll}
        >
          {conversations.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              selected={c.id === selectedId}
              onSelect={() => onSelect(c.id)}
            />
          ))}
          {conversations.length === 0 && (
            <div className="px-3 py-3 text-sm text-muted">{emptyLabel}</div>
          )}
          {isFetchingNextPage && <div className="px-3 pb-3 text-sm text-muted">Loading more...</div>}
        </ScrollArea>
        {/* Same condition as the fixed height above — rendering this on a
          queue that isn't scrollable at all would lie. */}
        {scrollable && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-black/10 to-transparent" />
        )}
      </div>
    </div>
  );
}

export function ConversationList({
  token,
  selectedId,
  onSelect,
}: {
  token: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const mine = useInfiniteQuery({
    queryKey: ['inbox', 'mine'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchInbox(token, 'mine', undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const escalated = useInfiniteQuery({
    queryKey: ['inbox', 'escalated'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchInbox(token, 'escalated', undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const mineConversations = mine.data?.pages.flatMap((page) => page.conversations) ?? [];
  const escalatedConversations = escalated.data?.pages.flatMap((page) => page.conversations) ?? [];

  useEffect(() => {
    const socket = createSocket(token, 'agent');
    let refetchTimer: ReturnType<typeof setTimeout> | undefined;

    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') handleSessionExpired();
    });

    /**
     * The badge updates from the socket payload; this only catches up the fields
     * the payload does not carry (`last_message_preview`, `last_message_at`, and
     * which tab a row belongs in). Trailing and coalesced, so a burst of inbound
     * messages costs one round trip instead of one per message, and the status
     * never waits on it — which matters because a refetch here is a full API
     * round trip and the console talks to the API through a tunnel.
     */
    const scheduleRefetch = () => {
      if (refetchTimer) clearTimeout(refetchTimer);
      refetchTimer = setTimeout(() => {
        refetchTimer = undefined;
        void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      }, 1000);
    };

    socket.on(
      'conversation:changed',
      (payload: { conversation_id?: unknown; status?: unknown }) => {
        const { conversation_id: id, status } = payload;
        if (typeof id !== 'string' || typeof status !== 'string') {
          scheduleRefetch();
          return;
        }

        let patched = false;
        for (const key of [
          ['inbox', 'mine'],
          ['inbox', 'escalated'],
        ]) {
          queryClient.setQueryData<InboxPages>(key, (current) => {
            if (!current) return current;
            let foundInThisList = false;
            const pages = current.pages.map((page) => {
              const index = page.conversations.findIndex((c) => c.id === id);
              if (index === -1) return page;
              foundInThisList = true;
              const conversations = page.conversations.slice();
              conversations[index] = {
                ...conversations[index]!,
                status: status as ConversationStatusValue,
              };
              return { ...page, conversations };
            });
            if (!foundInThisList) return current;
            patched = true;
            return { ...current, pages };
          });
        }

        // An id in neither list is a conversation that just appeared, or one that
        // moved between Unassigned and Mine. Neither can be rendered from
        // {id, status} alone, so that case still needs the server — immediately,
        // not on the trailing timer, or a new conversation would appear late.
        if (!patched) {
          void queryClient.invalidateQueries({ queryKey: ['inbox'] });
          return;
        }
        scheduleRefetch();
      },
    );

    return () => {
      if (refetchTimer) clearTimeout(refetchTimer);
      socket.close();
    };
  }, [token, queryClient]);

  const bothLoadedAndEmpty =
    mine.data &&
    escalated.data &&
    mineConversations.length === 0 &&
    escalatedConversations.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {bothLoadedAndEmpty ? (
        <EmptyState message="Nothing to show" />
      ) : (
        <>
          <ConversationQueue
            title="My tickets"
            testId="conversation-list-scroll-mine"
            conversations={mineConversations}
            selectedId={selectedId}
            onSelect={onSelect}
            emptyLabel="No open tickets."
            hasNextPage={mine.hasNextPage}
            isFetchingNextPage={mine.isFetchingNextPage}
            fetchNextPage={() => void mine.fetchNextPage()}
          />
          <ConversationQueue
            title="Escalated tickets"
            testId="conversation-list-scroll-escalated"
            conversations={escalatedConversations}
            selectedId={selectedId}
            onSelect={onSelect}
            emptyLabel="No escalated tickets."
            hasNextPage={escalated.hasNextPage}
            isFetchingNextPage={escalated.isFetchingNextPage}
            fetchNextPage={() => void escalated.fetchNextPage()}
          />
        </>
      )}
    </div>
  );
}
