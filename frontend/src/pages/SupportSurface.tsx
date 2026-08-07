import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BootstrapResponse, PlayerStateAvailability } from '@support/types'
import { fetchArticleDetail, fetchArticles, fetchBootstrap, reportArticleRead } from '../api/surfaceApi.ts'
import { fetchPlayerMessages, markPlayerMessagesRead, sendPlayerMessage } from '../api/playerChatApi.ts'
import { ChatThread } from '../components/chat/ChatThread.tsx'
import { Composer } from '../components/chat/Composer.tsx'
import type { ChatMessage } from '../components/chat/types.ts'
import { createSocket } from '../lib/socket.ts'
import { reconcilePending, type PendingMessage } from './chatReconcile.ts'
import { readBoot, scrubToken, type SurfaceBoot } from '../boot.ts'
import { post } from '../services/bridgeService.ts'

/** British spelling throughout, per the spec's own copy. */
const AVAILABILITY_COPY: Record<PlayerStateAvailability, string> = {
  ok: 'Player state received.',
  degraded: 'Player state is partial — the game could not read every field.',
  missing: 'Player state was delivered but the game returned nothing usable.',
  absent: 'Player state has not arrived yet. It may still be queued on the device.',
}

function toChatMessage(m: { id: string; author_type: ChatMessage['authorType']; body: string; created_at: string; delivery_state: NonNullable<ChatMessage['deliveryState']> }): ChatMessage {
  return { id: m.id, authorType: m.author_type, body: m.body, createdAt: m.created_at, deliveryState: m.delivery_state }
}

export function SupportSurface() {
  const [boot, setBoot] = useState<SurfaceBoot | null>(null)
  const [data, setData] = useState<BootstrapResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [read, setRead] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null)

  // StrictMode double-invokes mount effects in development. scrubToken removes the
  // fragment as a side effect of the first invocation, so a naive second run would
  // read an already-scrubbed URL, see no token, and set a false "no session token"
  // error alongside whatever the first run already loaded. The ref makes the body
  // idempotent instead of relying on removing StrictMode, which stays on deliberately.
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const parsed = readBoot(window.location)
    if (!parsed) {
      setError('This page must be opened by the game. No session token was supplied.')
      return
    }
    setBoot(parsed)
    scrubToken(window.history, window.location)

    fetchBootstrap(parsed.token, parsed.sessionId)
      .then(setData)
      .catch(() => {
        // Session might still be initializing via SDK POST /sdk/sessions/start.
        // The polling effect below will retry fetchBootstrap until the session lands.
      })
  }, [])

  // Poll until the session exists and player state snapshot availability is no longer 'absent'.
  useEffect(() => {
    if (!boot) return
    if (data !== null && data.player_state.availability !== 'absent') return

    let attempts = 0
    const maxAttempts = 15

    const interval = setInterval(() => {
      attempts += 1
      fetchBootstrap(boot.token, boot.sessionId)
        .then((next) => {
          setData(next)
          if (next.player_state.availability !== 'absent') {
            clearInterval(interval)
          }
        })
        .catch((cause: unknown) => {
          if (attempts >= maxAttempts && data === null) {
            clearInterval(interval)
            setError(cause instanceof Error ? cause.message : 'Could not load support.')
          }
        })
    }, 800)

    return () => clearInterval(interval)
  }, [boot, data])

  const articlesQuery = useQuery({
    queryKey: ['surfaceArticles', boot?.token, search],
    queryFn: () => fetchArticles(boot!.token, search || undefined),
    enabled: boot !== null,
  })

  const selectedArticleQuery = useQuery({
    queryKey: ['surfaceArticleDetail', boot?.token, selectedArticleId],
    queryFn: () => fetchArticleDetail(boot!.token, selectedArticleId!),
    enabled: boot !== null && selectedArticleId !== null,
  })

  const onRead = (articleId: string) => {
    if (!boot) return
    setSelectedArticleId(articleId)
    if (!read.includes(articleId)) {
      void reportArticleRead(boot.token, boot.sessionId, articleId).catch(() => {})
      post({ type: 'article_read', id: articleId })
      setRead((current) => [...current, articleId])
    }
  }

  const [chatOpen, setChatOpen] = useState(false)
  const [pending, setPending] = useState<PendingMessage[]>([])
  const queryClient = useQueryClient()

  const messagesQuery = useQuery({
    queryKey: ['playerMessages', boot?.sessionId],
    queryFn: () => fetchPlayerMessages(boot!.token, boot!.sessionId),
    enabled: chatOpen && boot !== null,
  })

  const send = useMutation({
    mutationFn: (body: string) => sendPlayerMessage(boot!.token, body),
    onMutate: (body: string) => {
      const tempId = `temp-${Date.now()}-${Math.random()}`
      setPending((current) => [
        ...current,
        { tempId, id: tempId, authorType: 'player', body, createdAt: new Date().toISOString(), deliveryState: 'sending' },
      ])
      return { tempId }
    },
    onSuccess: () => {
      // Deliberately does not clear `pending` here: chatReconcile.ts's
      // reconcilePending drops a pending entry only once the refetched server
      // list actually contains a matching message, so the optimistic bubble
      // never disappears and reappears in the gap before that refetch lands.
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot?.sessionId] })
    },
    onError: (_error, _body, context) => {
      setPending((current) =>
        current.map((p) => (p.tempId === context?.tempId ? { ...p, deliveryState: 'failed' } : p)),
      )
    },
  })

  const onRetry = (failed: ChatMessage) => {
    setPending((current) => current.filter((p) => p.id !== failed.id))
    send.mutate(failed.body)
  }

  useEffect(() => {
    if (!chatOpen || !boot) return
    const socket = createSocket(boot.token, 'player')
    socket.on('connect', () => {
      const conversationId = messagesQuery.data?.conversation_id
      if (conversationId) socket.emit('join_conversation', { conversation_id: conversationId })
    })
    socket.on('message:new', () => {
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot.sessionId] })
    })
    return () => {
      socket.close()
    }
  }, [chatOpen, boot, messagesQuery.data?.conversation_id, queryClient])

  useEffect(() => {
    const messages = messagesQuery.data?.messages
    if (!chatOpen || !boot || !messages || messages.length === 0) return
    const lastSeq = Math.max(...messages.map((m) => m.seq))
    void markPlayerMessagesRead(boot.token, lastSeq)
  }, [chatOpen, boot, messagesQuery.data])

  const serverMessages: ChatMessage[] = messagesQuery.data?.messages.map(toChatMessage) ?? []
  const chatMessages = reconcilePending(serverMessages, pending)

  return (
    <main className="surface">
      <h1>Support</h1>

      {error !== null && <p className="notice">{error}</p>}

      {data !== null && (
        <>
          <section>
            <h2>Session</h2>
            <dl>
              <dt>Session</dt>
              <dd>{data.session.id}</dd>
              <dt>Opened from</dt>
              <dd>{data.session.entry_point}</dd>
              <dt>Started</dt>
              <dd>{data.session.started_at}</dd>
              <dt>Player</dt>
              <dd>{data.player.external_player_id}</dd>
              <dt>Unread replies</dt>
              <dd>{data.unread_count}</dd>
            </dl>
          </section>

          <section>
            <h2>Player state</h2>
            {/* Missing data is a state, not an error: always a sentence, never a
                blank panel and never an error page. */}
            <p className="notice">{AVAILABILITY_COPY[data.player_state.availability]}</p>
            {data.player_state.degraded_reason !== null && (
              <p className="notice">Reason: {data.player_state.degraded_reason}</p>
            )}
            {/* captured_at is shown prominently on purpose: a reopened conversation
                keeps its original snapshot, so an agent could otherwise read a
                six-month-old client version as current. */}
            <p>Captured at: {data.player_state.captured_at ?? 'not captured'}</p>

            <h3>Declared</h3>
            <pre>{JSON.stringify(data.player_state.declared, null, 2)}</pre>

            {data.player_state.raw !== undefined && (
              <>
                <h3>Freeform</h3>
                <pre>{JSON.stringify(data.player_state.raw, null, 2)}</pre>
              </>
            )}
          </section>

          <section>
            <h2>Help Articles</h2>
            <div className="surface-articles__search">
              <input
                type="search"
                placeholder="Search help articles..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {articlesQuery.isLoading ? (
              <p className="notice">Loading help articles...</p>
            ) : articlesQuery.data?.articles.length === 0 ? (
              <p className="notice">No articles found.</p>
            ) : (
              <ul className="surface-articles__list">
                {articlesQuery.data?.articles.map((article) => (
                  <li key={article.id}>
                    <button type="button" onClick={() => onRead(article.id)}>
                      <span>{article.title}</span>
                      {read.includes(article.id) && <span className="read-badge">Read</span>}
                    </button>
                    {article.keywords.length > 0 && <p className="summary-snippet">{article.keywords.join(', ')}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {selectedArticleId !== null && selectedArticleQuery.data && (
        <div className="surface-modal-overlay" onClick={() => setSelectedArticleId(null)}>
          <div className="surface-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="surface-modal-header">
              <h2>{selectedArticleQuery.data.title}</h2>
              <button type="button" onClick={() => setSelectedArticleId(null)}>✕</button>
            </div>
            {selectedArticleQuery.data.keywords.length > 0 && (
              <p className="surface-modal-summary">{selectedArticleQuery.data.keywords.join(', ')}</p>
            )}
            <div className="surface-modal-body">
              {selectedArticleQuery.data.body}
            </div>
            <div className="surface-modal-footer">
              <button type="button" onClick={() => setSelectedArticleId(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Always on screen, whatever else happened — including when bootstrap failed.
          "Still need help?" and "Talk to a person" appear on every screen; there are
          no dead ends. Neither does anything yet beyond posting a bridge message: the
          real chat UI and handoff arrive with the conversation slice. */}
      <section>
        <button type="button" onClick={() => setChatOpen(true)}>
          Still need help?
        </button>
        <button type="button" onClick={() => setChatOpen(true)}>
          Talk to a person
        </button>
        <button type="button" onClick={() => post({ type: 'close' })}>
          Close
        </button>
      </section>

      {chatOpen && (
        <section className="chat-panel">
          <div className="chat-panel__thread">
            <ChatThread messages={chatMessages} currentAuthorType="player" onRetry={onRetry} />
          </div>
          {(messagesQuery.data?.status === 'resolved' || messagesQuery.data?.status === 'closed') && (
            <div className="notice">
              <p>Your ticket is resolved.</p>
              <p>
                Still facing issues?{' '}
                <button type="button" onClick={() => send.mutate("I'm still facing issues.")}>
                  Yes
                </button>
              </p>
            </div>
          )}
          <Composer onSend={(body) => send.mutate(body)} disabled={send.isPending} />
        </section>
      )}
    </main>
  )
}
