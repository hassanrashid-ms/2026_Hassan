import { getWeaviateClient } from './client.ts'

export type ArticleIndexInput = { id: string; title: string; body: string; keywords: string[]; intentId: string | null }

async function getArticleCollection() {
  const client = await getWeaviateClient()
  return client.collections.get('Article')
}

/** Weaviate's own object id is set to the article's UUID, per the design doc. */
export async function upsertArticleObject(input: ArticleIndexInput): Promise<void> {
  const collection = await getArticleCollection()
  const properties = {
    title: input.title,
    body: input.body,
    keywords: input.keywords,
    intentId: input.intentId ?? '',
    articleId: input.id,
  }
  const alreadyExists = await collection.data.exists(input.id)
  if (alreadyExists) {
    await collection.data.replace({ id: input.id, properties })
  } else {
    await collection.data.insert({ id: input.id, properties })
  }
}

export async function deleteArticleObject(id: string): Promise<void> {
  const collection = await getArticleCollection()
  await collection.data.deleteById(id)
}
