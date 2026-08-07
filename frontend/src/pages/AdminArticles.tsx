import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { AgentArticleDetail } from '@support/types'
import {
  archiveArticle,
  createArticle,
  createIntent,
  createSubintent,
  fetchArticle,
  fetchArticles,
  fetchIntents,
  publishArticle,
  updateArticle,
} from '../api/agentApi.ts'
import { loadAgentSession } from '../lib/agentSession.ts'
import { canEditFields, canPublish, parseKeywordsInput } from './articleForm.ts'

export function AdminArticles() {
  const navigate = useNavigate()
  const session = loadAgentSession()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ title: string; body: string; keywordsInput: string; intentId: string }>({
    title: '',
    body: '',
    keywordsInput: '',
    intentId: '',
  })
  const [newIntentName, setNewIntentName] = useState('')
  const [newSubintentName, setNewSubintentName] = useState('')

  useEffect(() => {
    if (!session) navigate('/login')
  }, [session, navigate])

  const intents = useQuery({
    queryKey: ['admin-intents'],
    queryFn: () => fetchIntents(session!.token),
    enabled: session !== null,
  })
  const articles = useQuery({
    queryKey: ['admin-articles'],
    queryFn: () => fetchArticles(session!.token),
    enabled: session !== null,
  })
  const selected = useQuery({
    queryKey: ['admin-article', selectedId],
    queryFn: () => fetchArticle(session!.token, selectedId!),
    enabled: session !== null && selectedId !== null,
  })

  useEffect(() => {
    if (selected.data) {
      setDraft({
        title: selected.data.title,
        body: selected.data.body,
        keywordsInput: selected.data.keywords.join(', '),
        intentId: selected.data.intent_id ?? '',
      })
    }
  }, [selected.data])

  const invalidateArticles = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-articles'] })
    void queryClient.invalidateQueries({ queryKey: ['admin-article', selectedId] })
  }

  const createDraft = useMutation({
    mutationFn: () =>
      createArticle(session!.token, {
        title: draft.title,
        body: draft.body,
        keywords: parseKeywordsInput(draft.keywordsInput),
        intent_id: draft.intentId || undefined,
      }),
    onSuccess: (created: AgentArticleDetail) => {
      setSelectedId(created.id)
      invalidateArticles()
    },
  })

  const saveDraft = useMutation({
    mutationFn: () =>
      updateArticle(session!.token, selectedId!, {
        title: draft.title,
        body: draft.body,
        keywords: parseKeywordsInput(draft.keywordsInput),
        intent_id: draft.intentId || null,
      }),
    onSuccess: invalidateArticles,
  })

  const publish = useMutation({
    mutationFn: () => publishArticle(session!.token, selectedId!),
    onSuccess: invalidateArticles,
  })

  const archive = useMutation({
    mutationFn: () => archiveArticle(session!.token, selectedId!),
    onSuccess: invalidateArticles,
  })

  const addIntent = useMutation({
    mutationFn: () => createIntent(session!.token, newIntentName),
    onSuccess: () => {
      setNewIntentName('')
      void queryClient.invalidateQueries({ queryKey: ['admin-intents'] })
    },
  })

  const addSubintent = useMutation({
    mutationFn: (intentId: string) => createSubintent(session!.token, intentId, newSubintentName),
    onSuccess: () => {
      setNewSubintentName('')
      void queryClient.invalidateQueries({ queryKey: ['admin-intents'] })
    },
  })

  if (!session) return null

  const state = selected.data?.state ?? 'draft'
  const editable = selectedId === null || canEditFields(state)

  return (
    <main className="admin-articles">
      <h1>Knowledge Base</h1>

      <section className="admin-articles__layout">
        <aside className="admin-articles__sidebar">
          <div className="admin-articles__card">
            <h2>Categories</h2>
            <ul className="admin-articles__list">
              {intents.data?.intents.map((intent) => (
                <li key={intent.id}>
                  <strong>{intent.name}</strong>
                  {intent.subintents.length > 0 && (
                    <ul className="admin-articles__list" style={{ paddingLeft: '0.8rem', marginTop: '0.2rem' }}>
                      {intent.subintents.map((s) => (
                        <li key={s.id}>• {s.name}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <input placeholder="New category name" value={newIntentName} onChange={(e) => setNewIntentName(e.target.value)} />
              <button type="button" onClick={() => addIntent.mutate()} disabled={addIntent.isPending || !newIntentName}>
                Add Category
              </button>
            </div>
          </div>

          <div className="admin-articles__card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <h2 style={{ margin: 0 }}>Articles</h2>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(null)
                  setDraft({ title: '', body: '', keywordsInput: '', intentId: '' })
                }}
              >
                + New
              </button>
            </div>
            <ul className="admin-articles__list">
              {articles.data?.articles.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className={selectedId === a.id ? 'active' : ''}
                    onClick={() => setSelectedId(a.id)}
                  >
                    <span>{a.title}</span>
                    <span style={{ fontSize: '0.75em', opacity: 0.7 }}>[{a.state}]</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="admin-articles__editor">
          <h2>{selectedId ? 'Edit Article' : 'New Article'}</h2>
          <div>
            <label style={{ fontSize: '0.8em', color: 'var(--muted)', display: 'block', marginBottom: '0.2rem' }}>Title</label>
            <input
              placeholder="Article title"
              value={draft.title}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </div>
          <div>
            <label style={{ fontSize: '0.8em', color: 'var(--muted)', display: 'block', marginBottom: '0.2rem' }}>Keywords</label>
            <input
              placeholder="refund, billing, cancel subscription"
              value={draft.keywordsInput}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, keywordsInput: e.target.value })}
            />
          </div>
          <div>
            <label style={{ fontSize: '0.8em', color: 'var(--muted)', display: 'block', marginBottom: '0.2rem' }}>Body</label>
            <textarea
              placeholder="Article body content..."
              value={draft.body}
              disabled={!editable}
              style={{ minHeight: '8rem' }}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </div>
          <div>
            <label style={{ fontSize: '0.8em', color: 'var(--muted)', display: 'block', marginBottom: '0.2rem' }}>Category</label>
            <select
              value={draft.intentId}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, intentId: e.target.value })}
            >
              <option value="">Uncategorized</option>
              {intents.data?.intents.map((intent) => (
                <option key={intent.id} value={intent.id}>
                  {intent.name}
                </option>
              ))}
            </select>
          </div>

          <div className="admin-articles__actions">
            {selectedId === null ? (
              <button type="button" onClick={() => createDraft.mutate()} disabled={createDraft.isPending || !draft.title || !draft.body}>
                Create Draft
              </button>
            ) : (
              <>
                <button type="button" onClick={() => saveDraft.mutate()} disabled={!editable || saveDraft.isPending}>
                  Save
                </button>
                <button type="button" onClick={() => publish.mutate()} disabled={!canPublish(state, draft.title, draft.body) || publish.isPending}>
                  Publish
                </button>
                <button type="button" onClick={() => archive.mutate()} disabled={archive.isPending}>
                  Archive
                </button>
              </>
            )}
          </div>
        </section>
      </section>
    </main>
  )
}
