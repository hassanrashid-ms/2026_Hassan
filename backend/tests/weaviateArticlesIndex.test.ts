import { beforeEach, describe, expect, it, vi } from 'vitest'

const insert = vi.fn()
const replace = vi.fn()
const deleteById = vi.fn()
const exists = vi.fn()
const collectionsGet = vi.fn(() => ({ data: { insert, replace, deleteById, exists } }))

vi.mock('../src/shared/weaviate/client.ts', () => ({
  getWeaviateClient: vi.fn().mockResolvedValue({ collections: { get: collectionsGet } }),
}))

beforeEach(() => {
  insert.mockReset()
  replace.mockReset()
  deleteById.mockReset()
  exists.mockReset()
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
