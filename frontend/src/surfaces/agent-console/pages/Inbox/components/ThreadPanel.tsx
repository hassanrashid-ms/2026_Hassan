import { useEffect, useState } from 'react';
import type {
  AgentMessageView,
  ConfirmPhaseValue,
  ConversationPriorityValue,
  ConversationStatusValue,
  ResolutionSourceValue,
} from '@support/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Archive, Clock, MessageSquare, PanelRight, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  askResolved,
  detachTag,
  escalateConversation,
  forceResolveConversation,
  fetchConversationContext,
  fetchConversationMessages,
  markAgentMessagesRead,
  sendAgentMessage,
  takeOverConversation,
  claimConversation,
  reassignConversation,
  requestUpload,
  putFileToUploadUrl,
  cancelUpload,
  fetchTemplates,
} from '../../../api/agentApi.ts';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { TagPicker } from './TagPicker.tsx';
import { AssignPicker } from './AssignPicker.tsx';
import { SubintentPicker } from './SubintentPicker.tsx';
import { PriorityPicker } from './PriorityPicker.tsx';
import { loadAgentSession, canBuildForms, isAdmin } from '../../../lib/agentSession.ts';
import { createSocket } from '../../../../../features/chat/api/socket.ts';
import { handleSessionExpired } from '../../../lib/authErrorHandling.ts';
import { tagBadgeClassName } from '../../../lib/tagBadge.ts';
import { ApiError } from '../../../../../lib/httpClient.ts';
import { ChatThread } from '../../../../../features/chat/components/ChatThread.tsx';
import { resolveTemplateBody } from '../../../../../features/chat/lib/resolveTemplateBody.ts';
import {
  reconcilePending,
  type PendingMessage,
} from '../../../../../features/chat/hooks/chatReconcile.ts';
import {
  Composer,
  type UploadedAttachment,
} from '../../../../../features/chat/components/Composer.tsx';
import type { ChatAttachment, ChatMessage } from '../../../../../features/chat/components/types.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { AttachmentLightbox } from '../../../components/AttachmentLightbox.tsx';
import { STATUS_BADGE_VARIANT, formatStatus } from './ConversationRow.tsx';
import { useAutoCloseCountdown } from './autoCloseCountdown.ts';

function toChatMessage(m: AgentMessageView): ChatMessage {
  return {
    id: m.id,
    authorType: m.author_type,
    authorName: m.author_name,
    body: m.body,
    createdAt: m.created_at,
    deliveryState: m.delivery_state,
    readAt: m.read_at,
    visibility: m.visibility,
    articleId: m.article_id,
    attachment: m.attachment
      ? {
          id: m.attachment.id,
          filename: m.attachment.filename,
          mimeType: m.attachment.mime_type,
          byteSize: m.attachment.byte_size,
          url: m.attachment.url,
        }
      : null,
  };
}

// Same reasoning as ConversationRow's MAX_VISIBLE_TAGS: the header is a
// toolbar, not the tag list — past a few, they crowd out the action buttons
// and force the row onto a second line.
const MAX_VISIBLE_HEADER_TAGS = 3;

function formatTicketDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** "Resolved by Sam" / "Resolved by the bot" / "Resolved — player asked to close it" / "Closed" when no source is known. */
function resolverLabel(
  source: ResolutionSourceValue | null | undefined,
  agentName: string | null | undefined,
): string {
  if (source === 'agent') return `Resolved by ${agentName ?? 'an agent'}`;
  if (source === 'admin_forced') return `Force-resolved by ${agentName ?? 'an admin'}`;
  if (source === 'bot') return 'Resolved by the bot';
  if (source === 'player_confirmed') return 'Resolved by the player';
  if (source === 'player_stated') return 'Resolved — player asked to close it';
  if (source === 'timed_out') return 'Resolved after no reply';
  return 'Closed';
}

export function ThreadPanel({
  token,
  conversationId,
  playerExternalId,
  status,
  priority,
  confirmPhase,
  readOnly = false,
  ticketNumber,
  resolutionSource,
  resolvedByAgentName,
  resolvedAt,
  autoCloseDays,
  openedAt,
  railOpen = false,
  onToggleRail,
  onBack,
  takeOverAvailable = false,
  claimAvailable = false,
  assignedAgentId,
  assignedAgentName,
}: {
  token: string;
  conversationId: string | null;
  playerExternalId?: string;
  status?: ConversationStatusValue;
  priority?: ConversationPriorityValue;
  confirmPhase?: ConfirmPhaseValue;
  readOnly?: boolean;
  ticketNumber?: number;
  resolutionSource?: ResolutionSourceValue | null;
  resolvedByAgentName?: string | null;
  resolvedAt?: string | null;
  autoCloseDays?: number;
  openedAt?: string;
  railOpen?: boolean;
  onToggleRail?: () => void;
  onBack?: () => void;
  takeOverAvailable?: boolean;
  claimAvailable?: boolean;
  assignedAgentId?: string | null;
  assignedAgentName?: string | null;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [expandedImage, setExpandedImage] = useState<ChatAttachment | null>(null);
  const countdownLabel = useAutoCloseCountdown(resolvedAt, autoCloseDays);

  const messagesQuery = useQuery({
    queryKey: ['conversation', conversationId, 'messages'],
    queryFn: () => fetchConversationMessages(token, conversationId!),
    enabled: conversationId !== null,
  });

  // Same cache key ContextRail uses, so this dedupes against its query rather
  // than fetching the context payload twice.
  const contextQuery = useQuery({
    queryKey: ['conversation', conversationId, 'context'],
    queryFn: () => fetchConversationContext(token, conversationId!),
    enabled: conversationId !== null,
    staleTime: 5 * 60_000,
  });
  const session = loadAgentSession();
  const templatesQuery = useQuery({
    queryKey: ['canned-replies'],
    queryFn: () => fetchTemplates(token),
    enabled: session !== null,
    select: (data) =>
      data.canned.map((reply) => ({
        id: reply.id,
        label: reply.label,
        body: resolveTemplateBody(reply.body, session!.displayName),
      })),
  });
  // The context payload has no top-level subintent — the rail's `tickets` list
  // includes the current conversation's own row (see AgentConversationContextResponse),
  // so that's where this conversation's subintent comes from.
  const subintent = contextQuery.data?.tickets.find((t) => t.id === conversationId)?.subintent;
  const tags = contextQuery.data?.tags ?? [];

  const detach = useMutation({
    mutationFn: (tagId: string) => detachTag(token, conversationId!, tagId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'context'] });
    },
  });

  const send = useMutation({
    mutationFn: ({
      body,
      visibility,
      attachment,
    }: {
      body: string;
      visibility?: 'public' | 'internal';
      attachment?: UploadedAttachment;
    }) =>
      sendAgentMessage(
        token,
        conversationId!,
        body,
        visibility,
        attachment
          ? {
              key: attachment.key,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              byteSize: attachment.byteSize,
            }
          : undefined,
      ),
    // The same optimistic handling the webview has had all along. Without it the
    // composer cleared and nothing appeared until the round trip finished, so a
    // slow send looked like a message that had vanished.
    onMutate: ({ body, visibility }) => {
      const tempId = `temp-${Date.now()}-${Math.random()}`;
      setPending((current) => [
        ...current,
        {
          tempId,
          id: tempId,
          authorType: 'agent',
          body,
          createdAt: new Date().toISOString(),
          deliveryState: 'sending',
          visibility: visibility ?? 'public',
        },
      ]);
      return { tempId };
    },
    onSuccess: (data, _variables, context) => {
      // `pending` is deliberately not cleared here: stamping the id the server
      // gave this message lets reconcilePending drop the bubble only once the
      // refetched list actually contains it, so it never blinks out in the gap
      // before that lands.
      setPending((current) =>
        current.map((p) =>
          p.tempId === context?.tempId ? { ...p, serverId: data.message.id } : p,
        ),
      );
      void queryClient.invalidateQueries({
        queryKey: ['conversation', conversationId, 'messages'],
      });
    },
    onError: (error, _variables, context) => {
      setPending((current) =>
        current.map((p) => (p.tempId === context?.tempId ? { ...p, deliveryState: 'failed' } : p)),
      );
      if (error instanceof ApiError && error.status === 409) {
        toast.error('This ticket was just resolved — your message was not sent.');
        void queryClient.invalidateQueries({
          queryKey: ['conversation', conversationId, 'detail'],
        });
      }
    },
  });

  const onRetry = (failed: ChatMessage) => {
    setPending((current) => current.filter((p) => p.id !== failed.id));
    send.mutate({ body: failed.body, visibility: failed.visibility });
  };

  const ask = useMutation({
    mutationFn: () => askResolved(token, conversationId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['conversation', conversationId, 'messages'],
      });
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'unassigned'] });
    },
  });

  const [confirmForceResolve, setConfirmForceResolve] = useState(false);
  const forceResolve = useMutation({
    mutationFn: () => forceResolveConversation(token, conversationId!),
    onSuccess: () => {
      setConfirmForceResolve(false);
      // Status can move out of any queue bucket into resolved, so this needs
      // the same breadth as invalidateAfterTakeOver below (detail + tickets +
      // tickets-summary), not just the mine/unassigned pair ask/escalate use —
      // ConversationDetailPane prefers a cached queue-row's status over
      // detail's, so leaving tickets-summary stale left the header showing
      // the old status until a manual reload.
      void queryClient.invalidateQueries({
        queryKey: ['conversation', conversationId, 'messages'],
      });
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'detail'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'unassigned'] });
    },
    onError: () => toast.error("Couldn't force resolve this conversation."),
  });

  const invalidateAfterEscalationChange = () => {
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] });
    void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] });
    void queryClient.invalidateQueries({ queryKey: ['inbox', 'unassigned'] });
  };

  const escalate = useMutation({
    mutationFn: () => escalateConversation(token, conversationId!),
    onSuccess: invalidateAfterEscalationChange,
  });

  const invalidateAfterTakeOver = () => {
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'detail'] });
    void queryClient.invalidateQueries({ queryKey: ['tickets'] });
    // Distinct top-level key from ['tickets', ...] — not covered by the
    // invalidation above. ConversationDetailPane prefers this stale summary's
    // status over the freshly-refetched detail, so without this the Take over
    // button and disabled Composer stick around until a manual reload.
    void queryClient.invalidateQueries({ queryKey: ['tickets-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] });
    void queryClient.invalidateQueries({ queryKey: ['inbox', 'unassigned'] });
  };

  const takeOver = useMutation({
    mutationFn: () => takeOverConversation(token, conversationId!),
    onSuccess: invalidateAfterTakeOver,
    onError: () => toast.error("Couldn't take over this conversation."),
  });

  // A conversation with no assigned agent yet is claimed via the claim
  // endpoint; one already held by another agent has to go through reassign
  // instead — claim's WHERE clause only ever matches an unassigned row, so
  // calling it here would 200 with `claimed: false` and silently do nothing.
  const claim = useMutation({
    mutationFn: async () => {
      if (assignedAgentId) {
        await reassignConversation(token, conversationId!, loadAgentSession()!.agentId);
        return;
      }
      await claimConversation(token, conversationId!);
    },
    onSuccess: invalidateAfterTakeOver,
    onError: () => toast.error("Couldn't take over this conversation."),
  });

  // Escalated can only move forward to resolved — asking is the only path there, since there is
  // no agent-side "mark resolved" anywhere in this product — so it stays askable while escalated.
  const askable =
    !readOnly &&
    (status === 'open' || status === 'awaiting_player' || status === 'escalated') &&
    (confirmPhase ?? 'none') === 'none';
  // Either ask puts the same question on the player's screen; the agent's panel
  // must read "waiting" for both, or a clock-triggered ask looks like no ask.
  const waiting = confirmPhase === 'agent_ask' || confirmPhase === 'inactivity_ask';
  const escalatable = !readOnly && (status === 'open' || status === 'awaiting_player');
  // Broader than askable on purpose: force-resolve exists for conversations
  // stuck outside the three askable statuses (e.g. bot_active with an
  // unreachable player), so it stays available anywhere short of terminal.
  const forceResolvable =
    !readOnly && isAdmin(loadAgentSession()) && status !== 'resolved' && status !== 'closed';

  // An optimistic bubble belongs to the thread it was typed in. Switching
  // conversations must drop it, or a send that is still in flight reappears
  // over someone else's transcript.
  useEffect(() => {
    setPending([]);
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    const socket = createSocket(token, 'agent', loadAgentSession()?.workspaceId);
    // Inside 'connect', not once at setup: rooms live on the server's socket
    // instance, so every reconnect — a backend restart, a laptop waking, a
    // dropped websocket — lands in a socket that has joined nothing. Emitting
    // once meant the panel went quiet after the first blip and only recovered
    // on remount, which reads as "read receipts stopped working".
    socket.on('connect', () => {
      socket.emit('join_conversation', { conversation_id: conversationId });
    });
    // The server rejects the handshake with 'unauthorized' for an expired or
    // revoked session token — the same failure an HTTP 401 reports, just over a
    // different transport, so it gets the same treatment.
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') handleSessionExpired();
    });
    socket.on('message:new', () => {
      void queryClient.invalidateQueries({
        queryKey: ['conversation', conversationId, 'messages'],
      });
    });
    socket.on('message:read', () => {
      void queryClient.invalidateQueries({
        queryKey: ['conversation', conversationId, 'messages'],
      });
    });
    // The player's answer arrives as a message; this is what tells the panel the
    // question is no longer outstanding, which no message body states.
    socket.on('conversation:phase_changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'detail'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'unassigned'] });
    });
    return () => {
      socket.emit('leave_conversation', { conversation_id: conversationId });
      socket.close();
    };
  }, [token, conversationId, queryClient]);

  useEffect(() => {
    // read_at is set once and never rewritten, so glancing at a June ticket for
    // context would permanently stamp receipts the player is shown. Reading
    // history must not write history.
    if (readOnly) return;
    const messages = messagesQuery.data?.messages;
    if (!conversationId || !messages || messages.length === 0) return;
    const lastSeq = Math.max(...messages.map((m) => m.seq));
    void markAgentMessagesRead(token, conversationId, lastSeq);
  }, [token, conversationId, messagesQuery.data, readOnly]);

  if (!conversationId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <MessageSquare className="size-8" />
        <p className="text-sm">Select a conversation</p>
      </div>
    );
  }

  const serverMessages: ChatMessage[] = messagesQuery.data?.messages.map(toChatMessage) ?? [];
  const chatMessages = reconcilePending(serverMessages, pending);

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
          {onBack && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onBack}
              aria-label="Back to list"
            >
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <span className="text-sm font-medium">{playerExternalId}</span>
          {status && <Badge variant={STATUS_BADGE_VARIANT[status]}>{formatStatus(status)}</Badge>}
          {conversationId && priority && (
            <PriorityPicker
              token={token}
              conversationId={conversationId}
              currentPriority={priority}
            />
          )}
          {conversationId && (
            <SubintentPicker
              token={token}
              conversationId={conversationId}
              currentSubintentId={subintent?.subintent_id}
              currentSubintentName={
                subintent
                  ? { intent_name: subintent.intent_name, subintent_name: subintent.subintent_name }
                  : null
              }
            />
          )}
          <div className="flex items-center gap-1.5">
            {tags.slice(0, MAX_VISIBLE_HEADER_TAGS).map((tag) => (
              <Badge key={tag.id} className={tagBadgeClassName(tag.colorIndex)}>
                {tag.name}
                <button
                  type="button"
                  aria-label="Remove tag"
                  disabled={detach.isPending}
                  onClick={() => detach.mutate(tag.id)}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            {/* Same "+N more" treatment as ConversationRow — the full list is
              still reachable via the TagPicker's attached-tags state, this is
              just the header's glance, not the source of truth. */}
            {tags.length > MAX_VISIBLE_HEADER_TAGS && (
              <span className="text-xs text-muted">+{tags.length - MAX_VISIBLE_HEADER_TAGS}</span>
            )}
            {conversationId && (
              <TagPicker
                token={token}
                conversationId={conversationId}
                attachedTagIds={tags.map((t) => t.id)}
              />
            )}
          </div>
          {conversationId && canBuildForms(loadAgentSession()) && (
            <AssignPicker
              token={token}
              conversationId={conversationId}
              currentAssigneeId={assignedAgentId}
              currentAssigneeName={assignedAgentName}
            />
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {takeOverAvailable && (
              <Button
                type="button"
                size="sm"
                disabled={takeOver.isPending}
                onClick={() => takeOver.mutate()}
              >
                Take over
              </Button>
            )}
            {claimAvailable && (
              <Button
                type="button"
                size="sm"
                disabled={claim.isPending}
                onClick={() => claim.mutate()}
              >
                Take over
              </Button>
            )}
            {/* Hidden outright when read-only: a disabled control here explains nothing. */}
            {!readOnly && (askable || waiting) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!askable || ask.isPending}
                // A real tooltip primitive isn't in this surface yet; the native
                // title is enough for a disabled-state explanation.
                title={waiting ? 'Waiting on player' : undefined}
                onClick={() => ask.mutate()}
              >
                Ask if resolved
              </Button>
            )}
            {escalatable && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={escalate.isPending}
                onClick={() => escalate.mutate()}
              >
                Escalate
              </Button>
            )}
            {forceResolvable && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={forceResolve.isPending}
                onClick={() => setConfirmForceResolve(true)}
              >
                Force resolve
              </Button>
            )}
            {onToggleRail && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Player context"
                aria-pressed={railOpen}
                onClick={onToggleRail}
              >
                <PanelRight className="size-4" />
              </Button>
            )}
          </div>
        </div>
        {/* Without this an agent lands on June's transcript and reasonably
          concludes the live ticket changed under them. */}
        {readOnly && (
          <div
            role="status"
            className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"
          >
            <Archive className="size-3.5 shrink-0" />
            {status === 'resolved' ? 'Viewing resolved ticket' : 'Viewing closed ticket'}
            {ticketNumber != null && ` · #${ticketNumber}`}
            {` · ${resolverLabel(resolutionSource, resolvedByAgentName)}`}
            {status === 'resolved' && countdownLabel && ` · ${countdownLabel}`}
          </div>
        )}
        <div className="min-h-0 flex-1">
          {/* Keyed on the conversation so switching threads remounts the list at
            the bottom instead of holding the previous thread's scroll offset.

            Not rendered until the messages are here. Virtuoso applies
            initialTopMostItemIndex once, at mount — mounting it against the
            empty list this query starts with spent that on nothing, and where
            the thread opened was then left to followOutput catching the first
            data arrival. Mounting with the real transcript makes the initial
            position the deterministic thing it reads as. */}
          {messagesQuery.data ? (
            <ChatThread
              key={conversationId}
              messages={chatMessages}
              currentAuthorType="agent"
              onRetry={onRetry}
              playerLabel={playerExternalId}
              onImageClick={setExpandedImage}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              {messagesQuery.isError ? 'Could not load this conversation.' : 'Loading…'}
            </div>
          )}
        </div>
        {/* The ask used to be visible only as a disabled header button with a
          native title. It is a state the whole panel is in — the agent is
          blocked on the player — so it says so where the agent is looking. */}
        {waiting && (
          <div
            role="status"
            className="flex shrink-0 items-center gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"
          >
            <Clock className="size-3.5 shrink-0" />
            Waiting on the player&rsquo;s answer to &ldquo;Did this solve it?&rdquo;
          </div>
        )}
        {/* No longer disabled on send.isPending: the optimistic bubble is the
          feedback now, and greying the composer for the length of a round trip
          was the most visible part of the lag it was meant to explain. Each
          send is independent, so a second one need not wait on the first. */}
        <Composer
          // Known limitation (see the design doc's "Out of scope"): a `public`
          // attachment sent here is not yet visible to the player — the webview
          // read path doesn't join `attachment` until that phase ships. Only
          // other agents viewing this thread see the image today.
          onSend={(body, visibility, attachment) => send.mutate({ body, visibility, attachment })}
          allowVisibilityToggle
          allowAttachments
          cannedReplies={templatesQuery.data ?? []}
          onUpload={async (file, onProgress) => {
            const { key, upload_url } = await requestUpload(token, {
              filename: file.name,
              contentType: file.type,
              byteSize: file.size,
            });
            await putFileToUploadUrl(upload_url, file, onProgress);
            return { key, filename: file.name, mimeType: file.type, byteSize: file.size };
          }}
          onCancelUpload={(key) => void cancelUpload(token, key)}
          disabled={!status || readOnly || takeOverAvailable || claimAvailable}
          placeholder={
            !status
              ? 'Loading...'
              : readOnly
                ? resolverLabel(resolutionSource, resolvedByAgentName)
                : takeOverAvailable || claimAvailable
                  ? 'Take over to send a message'
                  : undefined
          }
        />
      </div>
      <AttachmentLightbox attachment={expandedImage} onClose={() => setExpandedImage(null)} />
      <ConfirmDialog
        open={confirmForceResolve}
        onOpenChange={setConfirmForceResolve}
        title="Force resolve this conversation?"
        description="The player is not asked and is not notified. This cannot be undone."
        confirmLabel="Force resolve"
        variant="destructive"
        confirming={forceResolve.isPending}
        onConfirm={() => forceResolve.mutate()}
      />
    </>
  );
}
