import { beforeEach, describe, expect, it, vi } from 'vitest'

const insert = vi.fn()
const replace = vi.fn()
const deleteById = vi.fn()
const exists = vi.fn()
const bm25 = vi.fn()
const filterEqual = vi.fn((v: unknown) => ({ __filter: v }))
const filterByProperty = vi.fn(() => ({ equal: filterEqual }))
const collectionsGet = vi.fn(() => ({
  data: { insert, replace, deleteById, exists },
  query: { bm25 },
  filter: { byProperty: filterByProperty },
}))

vi.mock('../src/shared/weaviate/client.ts', () => ({
  getWeaviateClient: vi.fn().mockResolvedValue({ collections: { get: collectionsGet } }),
}))

beforeEach(() => {
  insert.mockReset()
  replace.mockReset()
  deleteById.mockReset()
  exists.mockReset()
  bm25.mockReset()
})

describe('upsertArticleObject', () => {
  it('inserts a new object when it does not already exist', async () => {
    const { upsertArticleObject } = await import('../src/shared/weaviate/articlesIndex.ts')
    exists.mockResolvedValue(false)

    await upsertArticleObject({ id: 'a1', title: 'T', body: 'B', keywords: ['k'], intentId: 'i1' })

    expect(collectionsGet).toHaveBeenCalledWith('Article')
    expect(insert).toHaveBeenCalledWith({
      id: 'a1',
      properties: { title: 'T', body: 'B', keywords: ['k'], intentId: 'i1', articleId: 'a1' },
    })
    expect(replace).not.toHaveBeenCalled()
  })

  it('replaces an existing object', async () => {
    const { upsertArticleObject } = await import('../src/shared/weaviate/articlesIndex.ts')
    exists.mockResolvedValue(true)

    await upsertArticleObject({ id: 'a1', title: 'T2', body: 'B2', keywords: [], intentId: null })

    expect(replace).toHaveBeenCalledWith({
      id: 'a1',
      properties: { title: 'T2', body: 'B2', keywords: [], intentId: '', articleId: 'a1' },
    })
    expect(insert).not.toHaveBeenCalled()
  })
})

describe('deleteArticleObject', () => {
  it('deletes the object by id', async () => {
    const { deleteArticleObject } = await import('../src/shared/weaviate/articlesIndex.ts')

    await deleteArticleObject('a1')

    expect(deleteById).toHaveBeenCalledWith('a1')
  })
})

describe('searchArticleIds', () => {
  it('queries BM25 with weighted properties and returns ranked article ids', async () => {
    const { searchArticleIds } = await import('../src/shared/weaviate/articlesIndex.ts')
    bm25.mockResolvedValue({ objects: [{ properties: { articleId: 'a2' } }, { properties: { articleId: 'a1' } }] })

    const ids = await searchArticleIds('refund', { intentId: 'i1', limit: 20 })

    expect(bm25).toHaveBeenCalledWith('refund', expect.objectContaining({
      queryProperties: ['title^3', 'keywords^2', 'body'],
      limit: 20,
    }))
    expect(ids).toEqual(['a2', 'a1'])
  })

  it('omits the filter when no intentId is given', async () => {
    const { searchArticleIds } = await import('../src/shared/weaviate/articlesIndex.ts')
    bm25.mockResolvedValue({ objects: [] })

    await searchArticleIds('refund', { limit: 20 })

    expect(bm25).toHaveBeenCalledWith('refund', expect.objectContaining({ filters: undefined }))
  })
})
