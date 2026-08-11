import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentArticleDetail } from '@support/types'
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  linkPlugin,
  linkDialogPlugin,
  quotePlugin,
  toolbarPlugin,
  BoldItalicUnderlineToggles,
  ListsToggle,
  BlockTypeSelect,
  CreateLink,
  UndoRedo,
} from '@mdxeditor/editor'
import '@mdxeditor/editor/style.css'
import {
  archiveArticle,
  createArticle,
  fetchArticle,
  fetchIntents,
  publishArticle,
  updateArticle,
} from '../../../api/agentApi.ts'
import { canEditFields, canPublish, parseKeywordsInput } from '../articleForm.ts'
import { Button } from '../../../components/ui/button.tsx'
import { Input } from '../../../components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select.tsx'
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../../../components/ui/sheet.tsx'

type Draft = { title: string; body: string; keywordsInput: string; intentId: string }

const EMPTY_DRAFT: Draft = { title: '', body: '', keywordsInput: '', intentId: '' }

export function ArticleEditorSheet({
  token,
  articleId,
  open,
  onOpenChange,
  onCreated,
}: {
  token: string
  articleId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  // The value MDXEditor's `markdown` prop is seeded with. Deliberately NOT
  // kept in sync with draft.body on every keystroke — MDXEditor treats a
  // prop change as an authoritative external reset and re-parses the whole
  // document from scratch, which was clobbering multi-block operations
  // (list-ifying a multi-line selection only applied to the last line) and
  // corrupting the link dialog's selection-anchor rect. It only needs to
  // change when switching articles, which the `key` below already forces a
  // remount for.
  const [editorSeed, setEditorSeed] = useState('')

  const intents = useQuery({ queryKey: ['admin-intents'], queryFn: () => fetchIntents(token) })
  const selected = useQuery({
    queryKey: ['admin-article', articleId],
    queryFn: () => fetchArticle(token, articleId!),
    enabled: articleId !== null,
  })

  useEffect(() => {
    if (articleId === null) {
      setDraft(EMPTY_DRAFT)
      setEditorSeed('')
    } else if (selected.data) {
      setDraft({
        title: selected.data.title,
        body: selected.data.body,
        keywordsInput: selected.data.keywords.join(', '),
        intentId: selected.data.intent_id ?? '',
      })
      setEditorSeed(selected.data.body)
    }
  }, [articleId, selected.data])

  const invalidateArticles = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-articles'] })
    void queryClient.invalidateQueries({ queryKey: ['admin-article', articleId] })
  }

  const createDraft = useMutation({
    mutationFn: () =>
      createArticle(token, {
        title: draft.title,
        body: draft.body,
        keywords: parseKeywordsInput(draft.keywordsInput),
        intent_id: draft.intentId || undefined,
      }),
    onSuccess: (created: AgentArticleDetail) => {
      invalidateArticles()
      onCreated(created.id)
    },
  })

  const saveDraft = useMutation({
    mutationFn: () =>
      updateArticle(token, articleId!, {
        title: draft.title,
        body: draft.body,
        keywords: parseKeywordsInput(draft.keywordsInput),
        intent_id: draft.intentId || null,
      }),
    onSuccess: invalidateArticles,
  })

  const publish = useMutation({ mutationFn: () => publishArticle(token, articleId!), onSuccess: invalidateArticles })
  const archive = useMutation({ mutationFn: () => archiveArticle(token, articleId!), onSuccess: invalidateArticles })

  const state = selected.data?.state ?? 'draft'
  const editable = articleId === null || canEditFields(state)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{articleId ? 'Edit Article' : 'New Article'}</SheetTitle>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {!editable && (
            <p className="rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900">
              This article is {state} and can no longer be edited{state === 'published' ? ' — only Archive is available.' : '.'}
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted">Title</label>
            <Input
              placeholder="Article title"
              value={draft.title}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted">Keywords</label>
            <Input
              placeholder="refund, billing, cancel subscription"
              value={draft.keywordsInput}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, keywordsInput: e.target.value })}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted">Category</label>
            <Select
              value={draft.intentId || undefined}
              disabled={!editable}
              onValueChange={(value) => setDraft({ ...draft, intentId: value })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Uncategorized" />
              </SelectTrigger>
              <SelectContent>
                {intents.data?.intents.map((intent) => (
                  <SelectItem key={intent.id} value={intent.id}>
                    {intent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-1.5">
            <label className="text-xs font-medium text-muted">Body</label>
            <div className="min-h-64 rounded-md border border-slate-200">
              <MDXEditor
                key={articleId ?? 'new'}
                markdown={editorSeed}
                readOnly={!editable}
                onChange={(markdown) => setDraft((d) => ({ ...d, body: markdown }))}
                contentEditableClassName="prose prose-sm max-w-none px-3 py-2 min-h-56"
                plugins={[
                  headingsPlugin(),
                  listsPlugin(),
                  linkPlugin(),
                  linkDialogPlugin(),
                  quotePlugin(),
                  toolbarPlugin({
                    toolbarContents: () => (
                      <>
                        <UndoRedo />
                        <BoldItalicUnderlineToggles />
                        <BlockTypeSelect />
                        <ListsToggle />
                        <CreateLink />
                      </>
                    ),
                  }),
                ]}
              />
            </div>
          </div>
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-slate-200">
          {articleId === null ? (
            <Button
              type="button"
              onClick={() => createDraft.mutate()}
              disabled={createDraft.isPending || !draft.title || !draft.body}
            >
              Create Draft
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => archive.mutate()} disabled={archive.isPending}>
                Archive
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => saveDraft.mutate()}
                disabled={!editable || saveDraft.isPending}
              >
                Save
              </Button>
              <Button
                type="button"
                onClick={() => publish.mutate()}
                disabled={!canPublish(state, draft.title, draft.body) || publish.isPending}
              >
                Publish
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
