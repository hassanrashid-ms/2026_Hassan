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
  const escalatedConversations =
    escalated.data?.pages.flatMap((page) => page.conversations) ?? [];

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

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (!nearBottom) return;
    if (mine.hasNextPage && !mine.isFetchingNextPage) void mine.fetchNextPage();
    if (escalated.hasNextPage && !escalated.isFetchingNextPage) void escalated.fetchNextPage();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea
        className="min-h-0 flex-1"
        viewportTestId="conversation-list-scroll"
        onScroll={handleScroll}
      >
        {bothLoadedAndEmpty ? (
          <EmptyState message="Nothing to show" />
        ) : (
          <>
            <div className="p-3 text-sm font-semibold">My tickets</div>
            {mineConversations.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                selected={c.id === selectedId}
                onSelect={() => onSelect(c.id)}
              />
            ))}
            {mineConversations.length === 0 && (
              <div className="px-3 pb-3 text-sm text-muted">No open tickets.</div>
            )}
            {mine.isFetchingNextPage && (
              <div className="px-3 pb-3 text-sm text-muted">Loading more...</div>
            )}

            <div className="p-3 text-sm font-semibold">Escalated tickets</div>
            {escalatedConversations.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                selected={c.id === selectedId}
                onSelect={() => onSelect(c.id)}
              />
            ))}
            {escalatedConversations.length === 0 && (
              <div className="px-3 pb-3 text-sm text-muted">No escalated tickets.</div>
            )}
            {escalated.isFetchingNextPage && (
              <div className="px-3 pb-3 text-sm text-muted">Loading more...</div>
            )}
          </>
        )}
      </ScrollArea>
    </div>
  );
}
