import { useEffect } from 'react';
import type { AgentConversationsResponse, ConversationStatusValue } from '@support/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchInbox } from '../../../api/agentApi.ts';
import { createSocket } from '../../../../../features/chat/api/socket.ts';
import { handleSessionExpired } from '../../../lib/authErrorHandling.ts';
import { ScrollArea } from '../../../components/ui/scroll-area.tsx';
import { EmptyState } from '../../../components/ui/empty-state.tsx';
import { ConversationRow } from './ConversationRow.tsx';

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
  const mine = useQuery({
    queryKey: ['inbox', 'mine'],
    queryFn: () => fetchInbox(token, 'mine'),
  });
  const escalated = useQuery({
    queryKey: ['inbox', 'escalated'],
    queryFn: () => fetchInbox(token, 'escalated'),
  });

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
          queryClient.setQueryData<AgentConversationsResponse>(key, (current) => {
            if (!current) return current;
            const index = current.conversations.findIndex((c) => c.id === id);
            if (index === -1) return current;
            const conversations = current.conversations.slice();
            conversations[index] = {
              ...conversations[index]!,
              status: status as ConversationStatusValue,
            };
            patched = true;
            return { ...current, conversations };
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
    mine.data && escalated.data &&
    mine.data.conversations.length === 0 &&
    escalated.data.conversations.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        {bothLoadedAndEmpty ? (
          <EmptyState message="Nothing to show" />
        ) : (
          <>
            <div className="p-3 text-sm font-semibold">My tickets</div>
            {mine.data?.conversations.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                selected={c.id === selectedId}
                onSelect={() => onSelect(c.id)}
              />
            ))}
            {mine.data?.conversations.length === 0 && (
              <div className="px-3 pb-3 text-sm text-muted">No open tickets.</div>
            )}

            <div className="p-3 text-sm font-semibold">Escalated tickets</div>
            {escalated.data?.conversations.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                selected={c.id === selectedId}
                onSelect={() => onSelect(c.id)}
              />
            ))}
            {escalated.data?.conversations.length === 0 && (
              <div className="px-3 pb-3 text-sm text-muted">No escalated tickets.</div>
            )}
          </>
        )}
      </ScrollArea>
    </div>
  );
}
