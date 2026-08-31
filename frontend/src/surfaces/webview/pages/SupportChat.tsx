import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TopBar } from '@/surfaces/webview/components/TopBar';
import { ChatBubbles } from '@/surfaces/webview/components/chat/ChatBubbles';
import { ChatComposer } from '@/surfaces/webview/components/chat/ChatComposer';
import { SupportButton } from '@/surfaces/webview/components/SupportButton';
import { BootstrapFailedScreen } from '@/surfaces/webview/components/StateScreens';
import { useSupport } from '@/surfaces/webview/components/SupportContext';
import { FormCard } from '@/surfaces/webview/components/chat/FormCard';
import { ArticleSheet } from '@/surfaces/webview/components/ArticleSheet';
import { useCloseOverlay } from '@/surfaces/webview/hooks/useCloseOverlay';
import {
  answerResolution,
  cancelUpload,
  fetchPlayerMessages,
  markPlayerMessagesRead,
  openNewTicket,
  postFormAnswer,
  putFileToUploadUrl,
  requestUpload,
  sendPlayerMessage,
  skipForm,
  submitForm,
} from '@/features/chat/api/playerChatApi';
import type { UploadedAttachment } from '@/features/chat/components/Composer';
import { createSocket } from '@/features/chat/api/socket';
import { reconcilePending, type PendingMessage } from '@/features/chat/hooks/chatReconcile';
import { showBotTyping } from './showBotTyping.ts';
import type { ChatAttachment, ChatMessage } from '@/features/chat/components/types';

function toChatMessage(m: {
  id: string;
  author_type: ChatMessage['authorType'];
  author_name?: string;
  body: string;
  created_at: string;
  delivery_state: NonNullable<ChatMessage['deliveryState']>;
  read_at: string | null;
  article_id: string | null;
  attachment?: {
    id: string;
    filename: string;
    mime_type: string;
    byte_size: number;
    url: string | null;
  } | null;
}): ChatMessage {
  return {
    id: m.id,
    authorType: m.author_type,
    authorName: m.author_name,
    body: m.body,
    createdAt: m.created_at,
    deliveryState: m.delivery_state,
    readAt: m.read_at,
    articleId: m.article_id,
    attachment: m.attachment ? toChatAttachment(m.attachment) : null,
  };
}

function toChatAttachment(a: {
  id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  url: string | null;
}): ChatAttachment {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mime_type,
    byteSize: a.byte_size,
    url: a.url,
  };
}

/**
 * Both banners are the same object: a sheet below the thread that owns the
 * player's next decision. Shared as a constant rather than a wrapper component
 * because the two differ only in their contents, and a one-prop wrapper would
 * hide that they must stay visually identical.
 */
const BANNER_CLASS = 'shrink-0 rounded-t-card border-t border-text/10 bg-surface px-4 pt-5 pb-5';

/**
 * The chat that used to be a panel inside the support surface, now its own route.
 *
 * Everything below the presentation layer is the same code doing the same thing:
 * the same query keys, the same socket lifecycle, the same optimistic-send
 * handling, the same read-receipt effect. What was `chatOpen` state is now the
 * fact that this route is mounted.
 *
 * This screen does not depend on bootstrap having *completed* — it needs only
 * boot.token and boot.sessionId, which exist the moment the URL parsed. It does
 * depend on the API being reachable, which is a different thing: without it
 * there is no thread to load and no way to deliver what the player types. When
 * the backend is down this renders the same failure screen every other screen
 * renders, rather than an empty thread above a composer that silently fails on
 * send.
 */
export function SupportChat() {
  const { boot, error, retry } = useSupport();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingMessage[]>([]);

  /*
   * The article sheet is a route, not state, so Android's back button closes it —
   * and it is a route NESTED under chat so that opening it never unmounts this
   * screen. The socket stays connected, the thread keeps its scroll position, and
   * a bot or agent message arriving mid-read still lands.
   */
  const { id: articleId } = useParams<{ id: string }>();
  const closeArticle = useCloseOverlay('/embed/support/chat');

  const messagesQuery = useQuery({
    queryKey: ['playerMessages', boot?.sessionId],
    queryFn: () => fetchPlayerMessages(boot!.token, boot!.sessionId),
    enabled: boot !== null,
  });

  const send = useMutation({
    mutationFn: (input: { body: string; attachment?: UploadedAttachment; formFieldKey?: string }) =>
      sendPlayerMessage(
        boot!.token,
        input.body,
        boot!.sessionId,
        input.attachment,
        input.formFieldKey,
      ),
    onMutate: (input: { body: string; attachment?: UploadedAttachment; formFieldKey?: string }) => {
      const tempId = `temp-${Date.now()}-${Math.random()}`;
      setPending((current) => [
        ...current,
        {
          tempId,
          id: tempId,
          authorType: 'player',
          body: input.body,
          createdAt: new Date().toISOString(),
          deliveryState: 'sending',
        },
      ]);
      return { tempId };
    },
    onSuccess: (data, _input, context) => {
      // Deliberately does not clear `pending` here: stamping the server's id on
      // the entry lets chatReconcile.ts's reconcilePending drop it only once the
      // refetched list actually contains that message, so the optimistic bubble
      // never disappears and reappears in the gap before that refetch lands.
      // deliveryState moves to 'sent' here, not just serverId: the bubble stays on
      // screen until the refetch lands, and while it still read 'sending' the
      // typing indicator could not tell an in-flight send from a delivered one.
      setPending((current) =>
        current.map((p) =>
          p.tempId === context?.tempId
            ? { ...p, serverId: data.message?.id, deliveryState: 'sent' }
            : p,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot?.sessionId] });
    },
    onError: (_error, _input, context) => {
      setPending((current) =>
        current.map((p) => (p.tempId === context?.tempId ? { ...p, deliveryState: 'failed' } : p)),
      );
    },
  });

  const answer = useMutation({
    mutationFn: (helped: boolean) => answerResolution(boot!.token, helped, boot!.sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot?.sessionId] });
    },
  });

  /**
   * Deliberately does not invalidate the messages query. The card owns its own
   * progress until terminate, and a refetch mid-form would remount it back to
   * whatever the server thinks the first unanswered question is — which, for a
   * player who went Back to correct question one, is the wrong one.
   */
  const formAnswer = useMutation({
    mutationFn: ({ fieldKey, value }: { fieldKey: string; value: unknown }) =>
      postFormAnswer(boot!.token, fieldKey, value, boot!.sessionId),
  });

  const formTerminate = useMutation({
    mutationFn: (action: 'submit' | 'skip') =>
      action === 'submit'
        ? submitForm(boot!.token, boot!.sessionId)
        : skipForm(boot!.token, boot!.sessionId),
    onSuccess: () => {
      // The terminate posts the summary card and flips the status, so the whole
      // thread is stale — unlike an answer, which changes nothing on screen.
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot?.sessionId] });
    },
  });

  const newTicket = useMutation({
    mutationFn: () => openNewTicket(boot!.token, boot!.sessionId),
    onSuccess: () => {
      // The query key is the session, not the conversation, so the cached list
      // would otherwise still hold the closed ticket's messages while the
      // refetch is in flight — the player would watch the old thread linger.
      // Removing the entry first drops straight to the "Say hello" empty state.
      queryClient.removeQueries({ queryKey: ['playerMessages', boot?.sessionId] });
      // Optimistic bubbles belong to the conversation that just closed; nothing
      // in the new thread will ever reconcile them.
      setPending([]);
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot?.sessionId] });
    },
  });

  const onRetry = (failed: ChatMessage) => {
    setPending((current) => current.filter((p) => p.id !== failed.id));
    send.mutate({ body: failed.body });
  };

  useEffect(() => {
    if (!boot) return;
    const socket = createSocket(boot.token, 'player');
    socket.on('connect', () => {
      const conversationId = messagesQuery.data?.conversation_id;
      if (conversationId) socket.emit('join_conversation', { conversation_id: conversationId });
    });
    socket.on('message:new', () => {
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot.sessionId] });
    });
    // The only signal for a decline: it posts no message and changes no status,
    // so nothing else would tell this screen to drop the banner.
    socket.on('conversation:phase_changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot.sessionId] });
    });
    // The payload's up_to_seq/read_at are deliberately unused. Refetching keeps
    // the "which messages count as read" rule in exactly one place — the server.
    socket.on('message:read', () => {
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot.sessionId] });
    });
    return () => {
      socket.close();
    };
  }, [boot, messagesQuery.data?.conversation_id, queryClient]);

  useEffect(() => {
    const messages = messagesQuery.data?.messages;
    if (!boot || !messages || messages.length === 0) return;
    const lastSeq = Math.max(...messages.map((m) => m.seq));
    void markPlayerMessagesRead(boot.token, lastSeq);
  }, [boot, messagesQuery.data]);

  const serverMessages: ChatMessage[] = messagesQuery.data?.messages.map(toChatMessage) ?? [];
  const chatMessages = reconcilePending(serverMessages, pending);

  const settled =
    messagesQuery.data?.status === 'resolved' || messagesQuery.data?.status === 'closed';
  // Explicit, not `!== 'none'`. The old check made every future enum value render
  // the yes/no banner by default, and 'form' is the value that proved it: the
  // banner would have appeared underneath the form card asking about an article
  // nobody had offered. So every new phase that IS a yes/no has to be added here
  // by hand — 'inactivity_ask' is one, and the inactivity clock's stage 1 is
  // unanswerable without it.
  const phase = messagesQuery.data?.confirm_phase ?? 'none';
  const confirmPending =
    phase === 'bot_article' || phase === 'agent_ask' || phase === 'inactivity_ask';
  const activeForm = phase === 'form' ? (messagesQuery.data?.form ?? null) : null;

  /**
   * Just enough of FormCard's own field-progress logic, duplicated rather than
   * lifted, to answer one question here: is the field the player would next
   * see an attachment field, and if so what's its key. Not FormCard's full
   * draft/committed state, which stays local to the card per its own design
   * comment — this is only ever read by the main composer's onSend below, and
   * that composer is already disabled while a form is active, so this is
   * defensive rather than reachable today.
   */
  const activeFormFields = activeForm
    ? [...activeForm.fields].sort((a, b) => a.position - b.position)
    : [];
  const activeFormAnsweredKeys = new Set((activeForm?.answers ?? []).map((a) => a.field_key));
  const activeFormFieldIndex = (() => {
    const firstUnanswered = activeFormFields.findIndex((f) => !activeFormAnsweredKeys.has(f.key));
    return firstUnanswered === -1 ? Math.max(activeFormFields.length - 1, 0) : firstUnanswered;
  })();
  const activeFormAttachmentFieldKey =
    activeFormFields[activeFormFieldIndex]?.type === 'attachment'
      ? activeFormFields[activeFormFieldIndex].key
      : undefined;

  /**
   * Two independent signals for the same condition, because either can be the
   * one that fires: the shell's `error` means bootstrap gave up after 15
   * attempts (the backend was already down when support opened), and
   * `messagesQuery.isError` means this screen's own fetch failed (it went down
   * after, or chat was opened directly). Reporting the shell's message when it
   * has one keeps the wording identical to what Home shows for the same outage.
   */
  // `data === undefined` qualifies the query half deliberately: once a thread
  // has loaded, a later refetch failing must not replace it with an error
  // screen. The player can still read what was said, and a send that cannot
  // reach the server already surfaces per-message as "Not sent. Retry" rather
  // than silently — so tearing the whole screen down would lose real content to
  // report a failure that is already reported.
  const unreachable = error !== null || (messagesQuery.isError && messagesQuery.data === undefined);
  const unreachableMessage =
    error ??
    (messagesQuery.error instanceof Error
      ? messagesQuery.error.message
      : 'Could not reach support. Check your connection and try again.');

  const isTyping = showBotTyping({
    lastMessage: chatMessages[chatMessages.length - 1],
    status: messagesQuery.data?.status,
    settled,
    confirmPending,
    hasActiveForm: activeForm !== null,
  });

  const onRetryConnection = () => {
    // Both, for the same reason both are checked above: whichever failed needs
    // re-arming, and retrying the one that did not is harmless.
    retry();
    void messagesQuery.refetch();
  };

  if (unreachable) {
    return (
      <>
        {/* The bar stays: closing the webview is the player's other way out of
            this, and it is the one action that still works with no backend. */}
        <TopBar variant="chat" />
        <div className="flex min-h-0 flex-1 flex-col">
          <BootstrapFailedScreen message={unreachableMessage} onRetry={onRetryConnection} />
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar variant="chat" />

      {/* min-h-0 is load-bearing: without it a flex child refuses to shrink below
          its content and the composer is pushed off the bottom of the viewport. */}
      <div className="min-h-0 flex-1">
        {messagesQuery.isPending ? null : chatMessages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <p className="text-lg font-semibold text-text">Say hello</p>
            <p className="text-base text-muted">
              Tell us what happened and we'll pick it up from here.
            </p>
          </div>
        ) : (
          <ChatBubbles messages={chatMessages} isTyping={isTyping} onRetry={onRetry} />
        )}
      </div>

      {activeForm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={activeForm.form_name}
          className={BANNER_CLASS}
        >
          {/* Keyed by the submission so an unrelated refetch — a socket
              message:new, a read receipt — cannot reset the player's progress. */}
          <FormCard
            key={activeForm.submission_id}
            form={activeForm}
            onAnswer={(fieldKey, value) => formAnswer.mutateAsync({ fieldKey, value })}
            onSubmit={() => formTerminate.mutate('submit')}
            onSkip={() => formTerminate.mutate('skip')}
            busy={formTerminate.isPending}
            onSendAttachment={async (fieldKey, file, onProgress) => {
              const uploaded = await requestUpload(boot!.token, {
                filename: file.name,
                contentType: file.type,
                byteSize: file.size,
              });
              await putFileToUploadUrl(uploaded.upload_url, file, onProgress);
              await sendPlayerMessage(
                boot!.token,
                '',
                boot!.sessionId,
                {
                  key: uploaded.key,
                  filename: file.name,
                  mimeType: file.type,
                  byteSize: file.size,
                },
                fieldKey,
              );
              // The card owns its own progress and deliberately never
              // refetches mid-form (see FormCard's docstring) — but the
              // attachment answer just posted a real message row, and that
              // message must show up in the thread once the field advances.
              void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot?.sessionId] });
            }}
          />
        </div>
      )}

      {confirmPending && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Is your issue resolved?"
          className={BANNER_CLASS}
        >
          <p className="text-lg font-semibold text-text">Is your issue resolved?</p>
          <p className="mt-1 text-sm text-muted">
            Let us know so we can close this or keep helping.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <SupportButton
              variant="primary"
              className="min-h-11 flex-1 px-4 py-2.5 text-base"
              disabled={answer.isPending}
              onClick={() => answer.mutate(true)}
            >
              Yes
            </SupportButton>
            <SupportButton
              variant="soft"
              className="min-h-11 flex-1 px-4 py-2.5 text-base"
              disabled={answer.isPending}
              onClick={() => answer.mutate(false)}
            >
              No
            </SupportButton>
          </div>
        </div>
      )}

      {settled && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Your ticket is resolved."
          className={BANNER_CLASS}
        >
          <p className="text-lg font-semibold text-text">Your ticket is resolved.</p>
          {/* Two exits, not one question with a Yes: reopen this thread, or end
              it and start a clean one. The old row only ever offered the reopen,
              so a player whose next problem was unrelated had nowhere to go. */}
          <p className="mt-1 text-sm text-muted">Need anything else?</p>
          <div className="mt-4 flex flex-col gap-2">
            <SupportButton
              variant="primary"
              className="min-h-11 w-full px-4 py-2.5 text-base"
              onClick={() => send.mutate({ body: "I'm still facing issues." })}
            >
              Still facing issues
            </SupportButton>
            <SupportButton
              variant="soft"
              className="min-h-11 w-full px-4 py-2.5 text-base"
              disabled={newTicket.isPending}
              onClick={() => newTicket.mutate()}
            >
              Open a new ticket
            </SupportButton>
          </div>
        </div>
      )}

      {/* A banner is a question the player has to answer before typing again:
          leaving the composer live let them talk past it and strand the
          conversation mid-decision. */}
      <ChatComposer
        onSend={(body, attachment) =>
          send.mutate({
            body,
            attachment,
            formFieldKey: activeFormAttachmentFieldKey,
          })
        }
        disabled={send.isPending || confirmPending || activeForm !== null || settled}
        // The bot can't read images: while it is the active responder there is
        // no path for an attached photo to reach anyone who can act on it, so
        // the control is not offered at all — the same UI-only gating pattern
        // as `settled` above, not new enforcement machinery.
        allowAttachments={messagesQuery.data?.status !== 'bot_active'}
        onUpload={async (file, onProgress) => {
          const uploaded = await requestUpload(boot!.token, {
            filename: file.name,
            contentType: file.type,
            byteSize: file.size,
          });
          await putFileToUploadUrl(uploaded.upload_url, file, onProgress);
          return {
            key: uploaded.key,
            filename: file.name,
            mimeType: file.type,
            byteSize: file.size,
          };
        }}
        onCancelUpload={(key) => {
          void cancelUpload(boot!.token, key);
        }}
      />

      {/* ArticleSheet fires its own once-per-session reportArticleRead and
          `article_read` bridge post. Correct: a player reading from a bot answer
          did read the article, and this is simply a third entry point to that
          signal. */}
      <ArticleSheet articleId={articleId ?? null} onClose={closeArticle} />
    </>
  );
}
