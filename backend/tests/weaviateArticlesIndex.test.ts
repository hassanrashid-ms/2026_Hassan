import { beforeEach, describe, expect, it, vi } from 'vitest'

const insert = vi.fn()
const replace = vi.fn()
const deleteById = vi.fn()
const exists = vi.fn()
const bm25 = vi.fn()
const filterEqual = vi.fn((v: unknown) => ({ __filter: v }))
const filterByProperty = vi.fn((name: string) => ({ equal: (v: unknown) => ({ __filter: v, __property: name }) }))
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
  filterEqual.mockClear()
  filterByProperty.mockClear()
})

describe('upsertArticleObject', () => {
  it('inserts a new object when it does not already exist', async () => {
    const { upsertArticleObject } = await import('../src/shared/weaviate/articlesIndex.ts')
    exists.mockResolvedValue(false)

    await upsertArticleObject({ id: 'a1', title: 'T', body: 'B', keywords: ['k'], intentId: 'i1', workspaceId: 'w1' })

    expect(collectionsGet).toHaveBeenCalledWith('Article')
    expect(insert).toHaveBeenCalledWith({
      id: 'a1',
      properties: { title: 'T', body: 'B', keywords: ['k'], intentId: 'i1', articleId: 'a1', workspaceId: 'w1' },
    })
    expect(replace).not.toHaveBeenCalled()
  })

  it('replaces an existing object', async () => {
    const { upsertArticleObject } = await import('../src/shared/weaviate/articlesIndex.ts')
    exists.mockResolvedValue(true)

    await upsertArticleObject({ id: 'a1', title: 'T2', body: 'B2', keywords: [], intentId: null, workspaceId: 'w1' })

    expect(replace).toHaveBeenCalledWith({
      id: 'a1',
      properties: { title: 'T2', body: 'B2', keywords: [], intentId: '', articleId: 'a1', workspaceId: 'w1' },
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it('fails within the timeout window when the Weaviate call hangs', async () => {
    const { upsertArticleObject, WEAVIATE_CALL_TIMEOUT_MS } = await import('../src/shared/weaviate/articlesIndex.ts')
    exists.mockReturnValue(new Promise(() => {})) // never resolves

    const start = Date.now()
    await expect(upsertArticleObject({ id: 'a1', title: 'T', body: 'B', keywords: [], intentId: null, workspaceId: 'w1' })).rejects.toThrow(
      /timed out/,
    )
    expect(Date.now() - start).toBeLessThan(WEAVIATE_CALL_TIMEOUT_MS + 2000)
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
  it('queries BM25 with weighted properties, workspace filter, and returns ranked article ids', async () => {
    const { searchArticleIds } = await import('../src/shared/weaviate/articlesIndex.ts')
    bm25.mockResolvedValue({ objects: [{ properties: { articleId: 'a2' } }, { properties: { articleId: 'a1' } }] })

    const ids = await searchArticleIds('refund', { workspaceId: 'w1', intentId: 'i1', limit: 20 })

    expect(filterByProperty).toHaveBeenCalledWith('workspaceId')
    expect(bm25).toHaveBeenCalledWith(
      'refund',
      expect.objectContaining({
        queryProperties: ['title^3', 'keywords^2', 'body'],
        limit: 20,
      }),
    )
    expect(ids).toEqual(['a2', 'a1'])
  })

  it('always filters on workspaceId even when no intentId is given', async () => {
    const { searchArticleIds } = await import('../src/shared/weaviate/articlesIndex.ts')
    bm25.mockResolvedValue({ objects: [] })

    await searchArticleIds('refund', { workspaceId: 'w1', limit: 20 })

    expect(filterByProperty).toHaveBeenCalledWith('workspaceId')
    expect(filterByProperty).not.toHaveBeenCalledWith('intentId')
    const call = bm25.mock.calls[0]!
    expect(call[1].filters).toEqual({ __filter: 'w1', __property: 'workspaceId' })
  })
})
