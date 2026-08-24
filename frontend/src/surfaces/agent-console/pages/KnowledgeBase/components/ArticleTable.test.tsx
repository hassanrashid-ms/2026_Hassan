import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArticleTable } from './ArticleTable.tsx';
import * as agentApi from '../../../api/agentApi.ts';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('ArticleTable title column', () => {
  it('clips a long title with an ellipsis instead of letting it wrap', async () => {
    const longTitle =
      'Troubleshooting: What to Do If the Game Crashes on Startup or During Loading Screens';
    vi.spyOn(agentApi, 'fetchArticles').mockResolvedValue({
      articles: [
        {
          id: 'art-1',
          title: longTitle,
          state: 'draft',
          intent_id: null,
          published_at: null,
          created_at: '2026-08-01T00:00:00Z',
        },
      ],
    });

    renderWithClient(
      <ArticleTable token="tok" selectedId={null} onSelect={() => {}} onNew={() => {}} />,
    );

    const cell = await screen.findByText(longTitle);
    // `max-w-0 w-full` gives the ellipsis something to clip against — without it,
    // `truncate` alone has no bound and the cell instead wraps character-by-character
    // whenever the table is squeezed next to the article editor sheet.
    expect(cell.className).toContain('truncate');
    expect(cell.className).toContain('max-w-0');
    expect(cell.getAttribute('title')).toBe(longTitle);
  });
});
