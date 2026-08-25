import { useEffect, useRef, useState } from 'react';
import type { AgentArticleDetail } from '@support/types';
import { createArticle, updateArticle } from '../../../api/agentApi.ts';

export type AutosaveStatus = 'unsaved' | 'saving' | 'saved';

type Fields = { title: string; body: string; keywords: string[]; intentId: string | undefined };

const DEBOUNCE_MS = 800;

export function useArticleAutosave(params: {
  token: string;
  articleId: string | null;
  onCreated: (id: string) => void;
  onSaved?: (article: AgentArticleDetail) => void;
  fields: Fields;
}): {
  status: AutosaveStatus;
  ensureArticleId: () => Promise<string>;
  flush: () => Promise<void>;
} {
  const { token, onCreated, onSaved } = params;
  const [status, setStatus] = useState<AutosaveStatus>('saved');

  // Refs, not state: this data must be read inside a debounced timeout closure
  // without re-triggering the effect that schedules it.
  const articleIdRef = useRef<string | null>(params.articleId);
  const fieldsRef = useRef<Fields>(params.fields);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<string> | null>(null);
  const firstRunRef = useRef(true);

  useEffect(() => {
    articleIdRef.current = params.articleId;
  }, [params.articleId]);

  async function persist(fields: Fields): Promise<void> {
    setStatus('saving');
    const body = {
      title: fields.title,
      body: fields.body,
      keywords: fields.keywords,
      intent_id: fields.intentId ?? null,
    };
    if (articleIdRef.current === null) {
      const created: AgentArticleDetail = await createArticle(token, {
        title: body.title,
        body: body.body,
        keywords: body.keywords,
        intent_id: body.intent_id ?? undefined,
      });
      articleIdRef.current = created.id;
      onCreated(created.id);
      onSaved?.(created);
    } else {
      // Write the server's response straight into the query cache (see
      // ArticleEditorForm's onSaved) instead of only invalidating — an
      // invalidated query still serves its stale cached value the instant
      // the sheet remounts, and only refetches after, which is exactly the
      // "close, reopen instantly → stale" glitch this replaces.
      const updated = await updateArticle(token, articleIdRef.current, body);
      onSaved?.(updated);
    }
    setStatus('saved');
  }

  useEffect(() => {
    const changed =
      fieldsRef.current.title !== params.fields.title ||
      fieldsRef.current.body !== params.fields.body ||
      fieldsRef.current.keywords.join(',') !== params.fields.keywords.join(',') ||
      fieldsRef.current.intentId !== params.fields.intentId;
    fieldsRef.current = params.fields;

    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    if (!changed) return;

    setStatus('unsaved');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      // A concurrent ensureArticleId() create already in flight wins — this
      // debounced save waits for it rather than racing a second create.
      const wait = inFlightRef.current ?? Promise.resolve('');
      const run = wait.then(() => persist(fieldsRef.current));
      inFlightRef.current = run.then(() => articleIdRef.current!);
    }, DEBOUNCE_MS);
    // No react-hooks/exhaustive-deps plugin is configured in this repo's
    // eslint config (see frontend/eslint.config.js) — a disable comment for it
    // is itself a lint error ("Definition for rule ... was not found"), so
    // there is nothing to suppress here.
  }, [params.fields.title, params.fields.body, params.fields.keywords, params.fields.intentId]);

  async function ensureArticleId(): Promise<string> {
    if (articleIdRef.current !== null) return articleIdRef.current;
    if (inFlightRef.current) return inFlightRef.current;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const run = persist(fieldsRef.current).then(() => articleIdRef.current!);
    inFlightRef.current = run;
    return run;
  }

  async function flush(): Promise<void> {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    await persist(fieldsRef.current);
  }

  return { status, ensureArticleId, flush };
}
