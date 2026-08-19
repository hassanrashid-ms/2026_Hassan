import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ArticleSheet } from './ArticleSheet.tsx'
import { SupportContextProvider } from './SupportContext.tsx'

/*
 * The hook is a real useQuery, so it is mocked at the module boundary rather than
 * spied on: this test is about what the sheet renders, not about fetching.
 *
 * The article is inlined in the factory on purpose. vi.mock is hoisted above every
 * other statement in the file, and the factory runs during the import of
 * ArticleSheet — so a module-level `const ARTICLE` referenced here would be in its
 * temporal dead zone and throw.
 */
vi.mock('@/surfaces/webview/hooks/useArticleDetail', () => ({
  useArticleDetail: () => ({
    data: {
      id: 'art-1',
      title: 'Refund policy',
      body: '## When we refund\n\nWe refund within **30 days** of purchase.',
      keywords: ['refund'],
    },
    isError: false,
  }),
}))

describe('ArticleSheet body', () => {
  // ArticleBody is lazy — it must not sit on the home screen's critical path —
  // so the assertions wait for the chunk rather than reading the first frame.
  it('renders the body as formatted markdown, not as raw syntax', async () => {
    render(
      <SupportContextProvider value={{ boot: null, data: null, error: null, retry: vi.fn() }}>
        <ArticleSheet articleId="art-1" onClose={vi.fn()} />
      </SupportContextProvider>,
    )

    expect(await screen.findByRole('heading', { name: 'When we refund' })).toBeInTheDocument()
    expect(screen.getByText('30 days').tagName).toBe('STRONG')
    // The bug this closes: players used to see the literal markers.
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument()
    expect(screen.queryByText(/##/)).not.toBeInTheDocument()
  })
})
