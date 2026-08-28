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
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import {
  askResolved,
  detachTag,
  escalateConversation,
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
} from '../../../api/agentApi.ts';
import { TagPicker } from './TagPicker.tsx';
import { AssignPicker } from './AssignPicker.tsx';
import { SubintentPicker } from './SubintentPicker.tsx';
import { PriorityPicker } from './PriorityPicker.tsx';
import { loadAgentSession, canBuildForms } from '../../../lib/agentSession.ts';
import { createSocket } from '../../../../../features/chat/api/socket.ts';
import { handleSessionExpired } from '../../../lib/authErrorHandling.ts';
import { tagBadgeClassName } from '../../../lib/tagBadge.ts';
import { ChatThread } from '../../../../../features/chat/components/ChatThread.tsx';
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
import { Dialog, DialogContent, DialogTitle } from '../../../components/ui/dialog.tsx';
import { STATUS_BADGE_VARIANT, formatStatus } from './ConversationRow.tsx';

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

function formatTicketDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** "Resolved by Sam" / "Resolved by the bot" / "Closed" when no source is known. */
function resolverLabel(
  source: ResolutionSourceValue | null | undefined,
  agentName: string | null | undefined,
): string {
  if (source === 'agent') return `Resolved by ${agentName ?? 'an agent'}`;
  if (source === 'bot') return 'Resolved by the bot';
  if (source === 'player_confirmed') return 'Resolved by the player';
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
    onError: (_error, _variables, context) => {
      setPending((current) =>
        current.map((p) => (p.tempId === context?.tempId ? { ...p, deliveryState: 'failed' } : p)),
      );
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
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-3">
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
          {tags.map((tag) => (
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
          {conversationId && (
            <TagPicker
              token={token}
              conversationId={conversationId}
              attachedTagIds={tags.map((t) => t.id)}
            />
          )}
          {conversationId && canBuildForms(loadAgentSession()) && (
            <AssignPicker
              token={token}
              conversationId={conversationId}
              currentAssigneeId={assignedAgentId}
              currentAssigneeName={assignedAgentName}
            />
          )}
          <div className="ml-auto flex items-center gap-2">
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
            Viewing an earlier ticket
            {ticketNumber != null && ` · #${ticketNumber}`}
            {/* "opened", not "resolved": the only date the API carries is
              created_at, and labelling it with the ticket's status would put a
              date in front of the agent that is not the date of that status. */}
            {openedAt && ` · ${status ?? 'resolved'} · opened ${formatTicketDate(openedAt)}`}
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
      {/* Owned here, not inside ChatThread/MessageBody: those are shared with
          the webview, and a click-to-expand lightbox is an agent-console-only,
          desktop affordance. */}
      <Dialog
        open={expandedImage !== null}
        onOpenChange={(open) => !open && setExpandedImage(null)}
      >
        {/* w-auto, not w-full: the content's own bounding box must hug the
            image, not stretch to max-w-[90vw] regardless of the image's real
            size — otherwise a click in the empty space around a small image
            still lands "inside" the dialog content and Radix's
            click-outside-to-close never fires. */}
        <DialogContent
          showCloseButton={false}
          className="w-auto max-w-[90vw] border-none bg-transparent p-0 shadow-none"
        >
          <DialogTitle className="sr-only">
            {expandedImage?.filename ?? 'Attachment preview'}
          </DialogTitle>
          {/* Own close button, not the Dialog's default small corner X: that
              default is styled for a solid bg-bg card and reads as nearly
              invisible against a photo or the transparent backdrop here. */}
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute -top-4 -right-4 z-10 flex size-9 items-center justify-center rounded-full bg-bg text-text shadow-lg outline-none hover:bg-muted/20"
          >
            <X className="size-5" />
          </DialogPrimitive.Close>
          {expandedImage?.url && (
            <img
              src={expandedImage.url}
              alt={expandedImage.filename}
              className="max-h-[85vh] max-w-[90vw] rounded-card object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
