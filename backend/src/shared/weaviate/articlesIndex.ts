import { Filters } from 'weaviate-client';
import { getWeaviateClient } from './client.ts';

export type ArticleIndexInput = {
  id: string;
  title: string;
  body: string;
  keywords: string[];
  intentId: string | null;
  workspaceId: string;
};

/**
 * Weaviate Cloud calls are made while an enclosing Postgres transaction (via `withWorkspace`) may
 * be open in `publishArticle`/`archiveArticle`. If Weaviate degrades, an unbounded call would hold
 * that transaction's connection/locks indefinitely. This timeout ensures the call always rejects
 * within a bounded window so the transaction rolls back instead of hanging.
 */
export const WEAVIATE_CALL_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number = WEAVIATE_CALL_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Weaviate call timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function getArticleCollection() {
  const client = await getWeaviateClient();
  return client.collections.get('Article');
}

/** Weaviate's own object id is set to the article's UUID, per the design doc. */
export async function upsertArticleObject(input: ArticleIndexInput): Promise<void> {
  const collection = await getArticleCollection();
  const properties = {
    title: input.title,
    body: input.body,
    keywords: input.keywords,
    intentId: input.intentId ?? '',
    articleId: input.id,
    workspaceId: input.workspaceId,
  };
  const alreadyExists = await withTimeout(collection.data.exists(input.id));
  if (alreadyExists) {
    await withTimeout(collection.data.replace({ id: input.id, properties }));
  } else {
    await withTimeout(collection.data.insert({ id: input.id, properties }));
  }
}

export async function deleteArticleObject(id: string): Promise<void> {
  const collection = await getArticleCollection();
  await withTimeout(collection.data.deleteById(id));
}

/**
 * BM25 scores a document `0` when it shares no term with the query — Weaviate still
 * returns up to `limit` of those zero-score objects rather than an empty set, so a
 * meaningless/unrelated query would otherwise come back with "matches" anyway. Asking
 * for the score back and dropping anything at or below this floor is what makes an
 * irrelevant query actually return nothing.
 */
export const MIN_BM25_SCORE = 0.05;

export async function searchArticleIds(
  query: string,
  opts: { workspaceId: string; intentId?: string; limit: number },
): Promise<string[]> {
  const collection = await getArticleCollection();
  const workspaceFilter = collection.filter.byProperty('workspaceId').equal(opts.workspaceId);
  const filters = opts.intentId
    ? Filters.and(workspaceFilter, collection.filter.byProperty('intentId').equal(opts.intentId))
    : workspaceFilter;
  const result = await collection.query.bm25(query, {
    queryProperties: ['title^3', 'keywords^2', 'body'],
    filters,
    limit: opts.limit,
    autoLimit: 1, // Cut off irrelevant results automatically if there's a score cliff
    returnProperties: ['articleId'],
    returnMetadata: ['score'],
  });
  return result.objects
    .filter((o) => (o.metadata?.score ?? 0) > MIN_BM25_SCORE)
    .map((o) => (o.properties as { articleId: string }).articleId);
}
