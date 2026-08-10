import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ArticleEditorSheet } from './ArticleEditorSheet.tsx'
import * as agentApi from '../../../api/agentApi.ts'

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

const EXISTING_ARTICLE = {
  id: 'art-1',
  title: 'Refunds',
  body: '# Refund policy\n\nWe refund within **30 days**.',
  keywords: ['refund'],
  state: 'draft' as const,
  intent_id: null,
  created_by: 'agent-1',
  published_by: null,
  published_at: null,
  created_at: '2026-08-01T00:00:00Z',
}

describe('ArticleEditorSheet MDXEditor round-trip', () => {
  it('writes markdown in and saves the same markdown back out', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE)
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] })
    const updateSpy = vi.spyOn(agentApi, 'updateArticle').mockResolvedValue(EXISTING_ARTICLE)

    renderWithClient(
      <ArticleEditorSheet token="tok" articleId="art-1" open onOpenChange={() => {}} onCreated={() => {}} />,
    )

    await screen.findByDisplayValue('Refunds')

    const saveButton = screen.getByRole('button', { name: /save/i })
    await userEvent.click(saveButton)

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        'tok',
        'art-1',
        expect.objectContaining({ body: expect.stringContaining('Refund policy') }),
      ),
    )
    // The same markdown emphasis marker round-trips unchanged.
    const [, , patch] = updateSpy.mock.calls[0]!
    expect(patch.body).toContain('**30 days**')
  })
})
