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
import { canEditFields, canPublish } from './articleForm.ts'

export function AdminArticles() {
  const navigate = useNavigate()
  const session = loadAgentSession()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ title: string; body: string; summary: string; intentId: string }>({
    title: '',
    body: '',
    summary: '',
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
        summary: selected.data.summary ?? '',
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
        summary: draft.summary || undefined,
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
        summary: draft.summary || null,
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
      <h1>Knowledge base</h1>

      <section>
        <h2>Categories</h2>
        <ul>
          {intents.data?.intents.map((intent) => (
            <li key={intent.id}>
              {intent.name}
              <ul>
                {intent.subintents.map((s) => (
                  <li key={s.id}>{s.name}</li>
                ))}
              </ul>
              <input
                placeholder="New subintent"
                value={newSubintentName}
                onChange={(e) => setNewSubintentName(e.target.value)}
              />
              <button type="button" onClick={() => addSubintent.mutate(intent.id)} disabled={addSubintent.isPending}>
                Add subintent
              </button>
            </li>
          ))}
        </ul>
        <input placeholder="New intent" value={newIntentName} onChange={(e) => setNewIntentName(e.target.value)} />
        <button type="button" onClick={() => addIntent.mutate()} disabled={addIntent.isPending}>
          Add intent
        </button>
      </section>

      <section className="admin-articles__layout">
        <div>
          <h2>Articles</h2>
          <button
            type="button"
            onClick={() => {
              setSelectedId(null)
              setDraft({ title: '', body: '', summary: '', intentId: '' })
            }}
          >
            New article
          </button>
          <ul>
            {articles.data?.articles.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => setSelectedId(a.id)}>
                  {a.title} ({a.state})
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2>{selectedId ? 'Edit article' : 'New article'}</h2>
          <input
            placeholder="Title"
            value={draft.title}
            disabled={!editable}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <textarea
            placeholder="Body"
            value={draft.body}
            disabled={!editable}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
          <textarea
            placeholder="Summary"
            value={draft.summary}
            disabled={!editable}
            onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
          />
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

          <fieldset disabled>
            <legend>Attachments — coming soon</legend>
          </fieldset>

          {selectedId === null ? (
            <button type="button" onClick={() => createDraft.mutate()} disabled={createDraft.isPending || !draft.title || !draft.body}>
              Create draft
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
    </main>
  )
}
