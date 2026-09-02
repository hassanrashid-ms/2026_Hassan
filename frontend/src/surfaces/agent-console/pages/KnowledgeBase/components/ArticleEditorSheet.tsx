import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentArticleDetail, ArticleAttachmentView, IntentView } from '@support/types';
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  linkPlugin,
  linkDialogPlugin,
  quotePlugin,
  thematicBreakPlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  imagePlugin,
  toolbarPlugin,
  BoldItalicUnderlineToggles,
  ListsToggle,
  BlockTypeSelect,
  CreateLink,
  InsertImage,
  UndoRedo,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import {
  archiveArticle,
  discardArticleDraft,
  fetchArticle,
  fetchIntents,
  finalizeArticleAttachment,
  publishArticle,
  putFileToUploadUrl,
  requestUpload,
  unarchiveArticle,
  generateKeywords,
} from '../../../api/agentApi.ts';
import {
  canEditFields,
  canPublish,
  EmptyMarkdownFileError,
  parseKeywordsInput,
  parseMarkdownImport,
} from '../articleForm.ts';
import { canBuildForms, type StoredAgentSession } from '../../../lib/agentSession.ts';
import { useArticleAutosave } from '../hooks/useArticleAutosave.ts';
import { ImageDialogAdapter } from './ImageDialogAdapter.tsx';
import { ArticleVersionHistoryTab } from './ArticleVersionHistoryTab.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { Input } from '../../../components/ui/input.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.tsx';
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../../../components/ui/sheet.tsx';
import { Skeleton } from '../../../components/ui/skeleton.tsx';
import { Switch } from '../../../components/ui/switch.tsx';
import { Loader2, Upload } from 'lucide-react';

type Draft = { title: string; body: string; keywordsInput: string; intentId: string };

function draftFrom(article: AgentArticleDetail | null): Draft {
  if (!article) return { title: '', body: '', keywordsInput: '', intentId: '' };
  const source = article.draft ?? article;
  return {
    title: source.title,
    body: source.body,
    keywordsInput: source.keywords.join(', '),
    intentId: article.intent_id ?? '',
  };
}

export function ArticleEditorSheet({
  token,
  session,
  articleId,
  open,
  onOpenChange,
  onCreated,
}: {
  token: string;
  session: StoredAgentSession;
  articleId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const intents = useQuery({ queryKey: ['admin-intents'], queryFn: () => fetchIntents(token) });
  const selected = useQuery({
    queryKey: ['admin-article', articleId],
    queryFn: () => fetchArticle(token, articleId!),
    enabled: articleId !== null,
  });

  // MDXEditor reads `markdown` only when it mounts — later prop changes are
  // ignored — so a form rendered before the fetch lands keeps a blank body for
  // the rest of the sheet's life, which is why closing and reopening "fixed"
  // it: the second open mounted against a warm cache. Hold the entire form back
  // until both queries have answered, then mount it once with real values. The
  // same gate stops the Category select from flashing "Uncategorized" before
  // the intents arrive.
  const loading = (articleId !== null && selected.isLoading) || intents.isLoading;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex flex-col gap-0 p-0 sm:max-w-2xl lg:w-[70vw] lg:max-w-none"
      >
        <SheetHeader>
          <SheetTitle>{articleId ? 'Edit Article' : 'New Article'}</SheetTitle>
        </SheetHeader>

        {loading ? (
          <div
            className="flex min-h-0 flex-1 flex-col gap-4 p-4"
            data-testid="article-editor-skeleton"
          >
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="min-h-64 flex-1" />
          </div>
        ) : selected.isError ? (
          <div className="flex min-h-0 flex-1 flex-col items-start gap-3 p-4">
            <p className="text-sm text-muted">This article could not be loaded.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void selected.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <ArticleEditorForm
            // Remounting per article re-seeds both the draft and the editor,
            // which is the only way to hand MDXEditor a new document.
            key={articleId ?? 'new'}
            token={token}
            session={session}
            articleId={articleId}
            article={selected.data ?? null}
            intents={intents.data?.intents ?? []}
            onCreated={onCreated}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ArticleEditorForm({
  token,
  session,
  articleId,
  article,
  intents,
  onCreated,
}: {
  token: string;
  session: StoredAgentSession;
  articleId: string | null;
  article: AgentArticleDetail | null;
  intents: IntentView[];
  onCreated: (id: string) => void;
}) {
  const canPublishOrArchive = canBuildForms(session);
  const queryClient = useQueryClient();
  const hasLiveContent = article !== null && article.state === 'published';
  const draftView = article?.draft ?? null;
  const editingMode: 'article' | 'draft' = hasLiveContent ? 'draft' : 'article';
  const [draft, setDraft] = useState<Draft>(() => draftFrom(article));
  const [useAIKeywords, setUseAIKeywords] = useState(false);
  const [attachments, setAttachments] = useState<ArticleAttachmentView[]>(
    article?.attachments ?? [],
  );
  const [resolvedArticleId, setResolvedArticleId] = useState(articleId);
  const [activeTab, setActiveTab] = useState<'edit' | 'history'>('edit');
  const [confirmAction, setConfirmAction] = useState<'archive' | 'unarchive' | 'publish' | null>(
    null,
  );
  // The value MDXEditor's `markdown` prop is seeded with. Deliberately NOT
  // kept in sync with draft.body on every keystroke — MDXEditor treats a
  // prop change as an authoritative external reset and re-parses the whole
  // document from scratch, which was clobbering multi-block operations
  // (list-ifying a multi-line selection only applied to the last line) and
  // corrupting the link dialog's selection-anchor rect. It only needs to
  // change when switching articles or importing a file, both of which force
  // a remount via `editorVersion` in the key below.
  const [editorSeed, setEditorSeed] = useState(() => article?.body ?? '');
  const [editorVersion, setEditorVersion] = useState(0);
  const importInputRef = useRef<HTMLInputElement>(null);
  // MDXEditor fires onChange once on mount with its own re-serialized markdown
  // (heading/list/escaping normalization), which can differ from `editorSeed`
  // byte-for-byte even though the user hasn't typed anything. Treating that
  // call as a real edit is what made opening a published article instantly
  // start a draft/autosave with zero user input — skip exactly one onChange
  // per mount (reset whenever `editorVersion` forces a fresh MDXEditor
  // instance, e.g. a markdown import).
  const editorInitializedRef = useRef(false);
  useEffect(() => {
    editorInitializedRef.current = false;
  }, [editorVersion]);

  const handleImportFile = async (file: File) => {
    try {
      const content = await file.text();
      const imported = parseMarkdownImport(content, file.name);
      setDraft({
        title: imported.title,
        body: imported.body,
        keywordsInput: imported.keywordsInput,
        intentId: draft.intentId,
      });
      setEditorSeed(imported.body);
      setEditorVersion((v) => v + 1);
      if (imported.frontmatterError) {
        toast.error("Couldn't parse frontmatter — imported the file as plain markdown.");
      }
    } catch (error) {
      if (error instanceof EmptyMarkdownFileError) {
        toast.error('File is empty.');
      } else {
        toast.error('Could not read that file.');
      }
    }
  };

  const generateKeywordsMutation = useMutation({
    mutationFn: () => generateKeywords(token, { title: draft.title, body: draft.body }),
    onSuccess: (data) => setDraft((d) => ({ ...d, keywordsInput: data.keywords.join(', ') })),
  });

  const invalidateArticles = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-articles'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-article', articleId] });
  };

  const autosave = useArticleAutosave({
    token,
    articleId: resolvedArticleId,
    mode: editingMode,
    onCreated: (id) => {
      setResolvedArticleId(id);
      invalidateArticles();
      onCreated(id);
    },
    onSaved: (saved) => {
      queryClient.setQueryData<AgentArticleDetail>(['admin-article', saved.id], saved);
    },
    fields: {
      title: draft.title,
      body: draft.body,
      keywords: parseKeywordsInput(draft.keywordsInput),
      intentId: draft.intentId || undefined,
    },
  });

  useEffect(() => {
    return () => {
      void autosave.flush();
    };
    // No react-hooks/exhaustive-deps plugin is configured in this repo's
    // eslint config, so there is no rule to disable here — this effect is
    // deliberately mount/unmount-only (flush on unmount), not deps-driven.
  }, []);

  const publish = useMutation({
    mutationFn: () => publishArticle(token, resolvedArticleId!),
    onSuccess: () => {
      setConfirmAction(null);
      invalidateArticles();
    },
  });
  const archive = useMutation({
    mutationFn: () => archiveArticle(token, resolvedArticleId!),
    onSuccess: () => {
      setConfirmAction(null);
      invalidateArticles();
    },
  });
  const unarchive = useMutation({
    mutationFn: () => unarchiveArticle(token, resolvedArticleId!),
    onSuccess: (updated) => {
      setConfirmAction(null);
      queryClient.setQueryData<AgentArticleDetail>(['admin-article', updated.id], updated);
      invalidateArticles();
    },
  });
  const discardDraft = useMutation({
    mutationFn: () => discardArticleDraft(token, resolvedArticleId!),
    onSuccess: (updated) => {
      queryClient.setQueryData<AgentArticleDetail>(['admin-article', updated.id], updated);
      invalidateArticles();
      // `draft`/`editorSeed` are local state, seeded once from the article prop
      // at mount — they don't track later prop changes (see the comment above
      // `editorSeed`), so without this the form keeps showing the just-discarded
      // draft content until the sheet is closed and reopened. Revert them to the
      // live content the server just reported, and bump editorVersion to force
      // MDXEditor to remount against the reverted body (its `markdown` prop is
      // otherwise only read once, on mount).
      const reverted = draftFrom(updated);
      setDraft(reverted);
      setEditorSeed(reverted.body);
      setEditorVersion((v) => v + 1);
      setAttachments(updated.attachments);
      // Without this, the autosave hook reads the revert itself as a fresh
      // edit (its last-seen fields still hold the just-discarded draft
      // content) and immediately schedules a save — spawning a brand new,
      // content-identical draft the instant the old one was discarded.
      autosave.syncFields({
        title: reverted.title,
        body: reverted.body,
        keywords: parseKeywordsInput(reverted.keywordsInput),
        intentId: reverted.intentId || undefined,
      });
    },
  });

  const state = article?.state ?? 'draft';
  const editable = articleId === null || canEditFields(state);

  const formContent = (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {state === 'archived' && (
          <p className="rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900">
            This article is archived and can no longer be edited.
          </p>
        )}

        {hasLiveContent && (
          <div className="flex items-center justify-between rounded-md bg-slate-100 px-3 py-2 text-xs">
            <span className="font-medium">Live: v{article!.version}</span>
            {draftView && (
              <span className="text-muted">
                Draft in progress · saved {new Date(draftView.updated_at).toLocaleTimeString()}
              </span>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <input
            ref={importInputRef}
            type="file"
            accept=".md,.markdown"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleImportFile(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!editable}
            onClick={() => importInputRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" />
            Import from Markdown
          </Button>
        </div>

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
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted">Keywords</label>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted">Generate with AI</label>
              <Switch
                checked={useAIKeywords}
                onCheckedChange={setUseAIKeywords}
                disabled={!editable}
              />
            </div>
          </div>
          {useAIKeywords ? (
            <div className="flex gap-2">
              <Input
                placeholder="refund, billing, cancel subscription"
                value={draft.keywordsInput}
                disabled={true}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => generateKeywordsMutation.mutate()}
                disabled={generateKeywordsMutation.isPending || !draft.title || !draft.body}
              >
                {generateKeywordsMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Generate
              </Button>
            </div>
          ) : (
            <Input
              placeholder="refund, billing, cancel subscription"
              value={draft.keywordsInput}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, keywordsInput: e.target.value })}
            />
          )}
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
              {intents.map((intent) => (
                <SelectItem key={intent.id} value={intent.id}>
                  {intent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* No `flex-1 min-h-0` here: that combination is for a section that scrolls on
            its own, which this doesn't (it has no overflow-y-auto of its own). Applied
            to a child of the already-scrollable form container below, it instead let
            flexbox shrink this field below the editor's actual content height once the
            whole form got tall enough — the bordered box would stop growing and the
            editor's content would render past its bottom edge, uncontained. A plain
            block here just contributes its full height to the form's own scroll area. */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted">Body</label>
          <div className="min-h-64 rounded-md border border-slate-200">
            <MDXEditor
              key={editorVersion}
              markdown={editorSeed}
              readOnly={!editable}
              onChange={(markdown) => {
                if (!editorInitializedRef.current) {
                  editorInitializedRef.current = true;
                  return;
                }
                setDraft((d) => ({ ...d, body: markdown }));
              }}
              contentEditableClassName="prose prose-sm max-w-none px-3 py-2 min-h-56"
              plugins={[
                headingsPlugin(),
                listsPlugin(),
                linkPlugin(),
                linkDialogPlugin(),
                quotePlugin(),
                // Without these, MDXEditor's markdown parser throws on the first
                // `---` divider or fenced code block it hits and silently drops
                // everything after — invisible while authoring by hand via the
                // toolbar, but real-world imported markdown routinely has both.
                // codeBlockPlugin alone still throws on render unless a
                // matching CodeBlockEditorDescriptor exists, so codeMirrorPlugin
                // must be registered too — it supplies that descriptor.
                thematicBreakPlugin(),
                codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
                codeMirrorPlugin({
                  codeBlockLanguages: {
                    '': 'Plain text',
                    text: 'Plain text',
                    txt: 'Plain text',
                    bash: 'Bash',
                    sh: 'Shell',
                    json: 'JSON',
                    js: 'JavaScript',
                    ts: 'TypeScript',
                    yaml: 'YAML',
                    html: 'HTML',
                    css: 'CSS',
                  },
                }),
                imagePlugin({
                  imageUploadHandler: async (file: File) => {
                    const id = await autosave.ensureArticleId();
                    const uploaded = await requestUpload(token, {
                      filename: file.name,
                      contentType: file.type,
                      byteSize: file.size,
                    });
                    await putFileToUploadUrl(uploaded.upload_url, file);
                    const attachment = await finalizeArticleAttachment(token, id, {
                      key: uploaded.key,
                      filename: file.name,
                      mimeType: file.type,
                      byteSize: file.size,
                    });
                    setAttachments((current) => [...current, attachment]);
                    return `attachment:${attachment.id}`;
                  },
                  imagePreviewHandler: async (src: string) => {
                    if (!src.startsWith('attachment:')) return src;
                    const id = src.slice('attachment:'.length);
                    return attachments.find((a) => a.id === id)?.url ?? src;
                  },
                  ImageDialog: ImageDialogAdapter,
                }),
                toolbarPlugin({
                  toolbarContents: () => (
                    <>
                      <UndoRedo />
                      <BoldItalicUnderlineToggles />
                      <BlockTypeSelect />
                      <ListsToggle />
                      <CreateLink />
                      <InsertImage />
                    </>
                  ),
                }),
              ]}
            />
          </div>
        </div>
      </div>
    </>
  );

  return (
    <>
      {hasLiveContent ? (
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as 'edit' | 'history')}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <TabsList className="mx-4 mt-2 w-fit">
            <TabsTrigger value="edit">Edit</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent
            value="edit"
            className="flex min-h-0 flex-1 flex-col gap-0 data-[state=inactive]:hidden"
            forceMount
          >
            {formContent}
          </TabsContent>
          <TabsContent value="history" className="min-h-0 flex-1 overflow-auto p-4">
            <ArticleVersionHistoryTab
              token={token}
              articleId={resolvedArticleId!}
              onRestored={() => setActiveTab('edit')}
            />
          </TabsContent>
        </Tabs>
      ) : (
        formContent
      )}

      <SheetFooter className="flex-row justify-end gap-2 border-t border-slate-200">
        <div className="flex items-center gap-2 text-xs text-muted">
          {autosave.status === 'unsaved' && 'Unsaved'}
          {autosave.status === 'saving' && 'Saving…'}
          {autosave.status === 'saved' && 'Saved'}
        </div>
        {canPublishOrArchive && draftView && (
          <Button
            type="button"
            variant="outline"
            onClick={() => discardDraft.mutate()}
            disabled={discardDraft.isPending}
          >
            Discard draft
          </Button>
        )}
        {canPublishOrArchive && state === 'archived' && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmAction('unarchive')}
            disabled={resolvedArticleId === null || unarchive.isPending}
          >
            Unarchive
          </Button>
        )}
        {canPublishOrArchive && state === 'published' && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmAction('archive')}
            disabled={resolvedArticleId === null || archive.isPending}
          >
            Archive
          </Button>
        )}
        {canPublishOrArchive && (
          <Button
            type="button"
            onClick={() => setConfirmAction('publish')}
            disabled={
              resolvedArticleId === null ||
              !canPublish(state, draft.title, draft.body) ||
              publish.isPending
            }
          >
            Publish
          </Button>
        )}
      </SheetFooter>

      <ConfirmDialog
        open={confirmAction === 'publish'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={hasLiveContent ? 'Publish this draft?' : 'Publish this article?'}
        description={
          hasLiveContent
            ? `This makes the draft the new live version (v${(article?.version ?? 1) + 1}), visible to players immediately.`
            : 'This makes the article visible to players immediately.'
        }
        confirmLabel="Publish"
        confirming={publish.isPending}
        onConfirm={() => publish.mutate()}
      />
      <ConfirmDialog
        open={confirmAction === 'archive'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title="Archive this article?"
        description="It's removed from player-facing search and the bot's knowledge base immediately. You can unarchive it later without losing its content or version history."
        confirmLabel="Archive"
        variant="destructive"
        confirming={archive.isPending}
        onConfirm={() => archive.mutate()}
      />
      <ConfirmDialog
        open={confirmAction === 'unarchive'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title="Unarchive this article?"
        description="It goes back to published with its existing content and re-enters the bot's knowledge base immediately."
        confirmLabel="Unarchive"
        confirming={unarchive.isPending}
        onConfirm={() => unarchive.mutate()}
      />
    </>
  );
}
