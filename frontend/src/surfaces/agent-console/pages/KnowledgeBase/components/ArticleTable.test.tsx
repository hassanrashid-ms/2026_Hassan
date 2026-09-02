import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArticleTable } from './ArticleTable.tsx';
import * as agentApi from '../../../api/agentApi.ts';

const TWO_ARTICLES = [
  {
    id: 'art-1',
    title: 'Refund Policy',
    body: 'Body one.',
    state: 'draft' as const,
    version: 0,
    has_draft: false,
    intent_id: null,
    published_at: null,
    created_at: '2026-08-01T00:00:00Z',
  },
  {
    id: 'art-2',
    title: 'Getting Started',
    body: 'Body two.',
    state: 'draft' as const,
    version: 0,
    has_draft: false,
    intent_id: null,
    published_at: null,
    created_at: '2026-08-01T00:00:00Z',
  },
];

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
          body: 'irrelevant',
          state: 'draft',
          version: 0,
          has_draft: false,
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

describe('ArticleTable title fallback', () => {
  it('falls back to the first two words of the body when there is no title', async () => {
    vi.spyOn(agentApi, 'fetchArticles').mockResolvedValue({
      articles: [
        {
          id: 'art-1',
          title: '',
          body: 'Refund policy details',
          state: 'draft',
          version: 0,
          has_draft: false,
          intent_id: null,
          published_at: null,
          created_at: '2026-08-01T00:00:00Z',
        },
      ],
    });

    renderWithClient(
      <ArticleTable token="tok" selectedId={null} onSelect={() => {}} onNew={() => {}} />,
    );

    expect(await screen.findByText('Refund policy')).toBeInTheDocument();
  });

  it('falls back to "Untitled" when there is neither a title nor a body', async () => {
    vi.spyOn(agentApi, 'fetchArticles').mockResolvedValue({
      articles: [
        {
          id: 'art-1',
          title: '',
          body: '',
          state: 'draft',
          version: 0,
          has_draft: false,
          intent_id: null,
          published_at: null,
          created_at: '2026-08-01T00:00:00Z',
        },
      ],
    });

    renderWithClient(
      <ArticleTable token="tok" selectedId={null} onSelect={() => {}} onNew={() => {}} />,
    );

    expect(await screen.findByText('Untitled')).toBeInTheDocument();
  });
});

describe('ArticleTable bulk selection', () => {
  it('selects rows via checkbox and shows a bulk action bar with the count', async () => {
    vi.spyOn(agentApi, 'fetchArticles').mockResolvedValue({ articles: TWO_ARTICLES });

    renderWithClient(
      <ArticleTable token="tok" selectedId={null} onSelect={() => {}} onNew={() => {}} />,
    );

    const checkbox = await screen.findByLabelText('Select Refund Policy');
    checkbox.click();

    expect(await screen.findByText('1 selected')).toBeInTheDocument();
  });

  it('exports the selected ids as a zip download', async () => {
    vi.spyOn(agentApi, 'fetchArticles').mockResolvedValue({ articles: TWO_ARTICLES });
    const blob = new Blob(['zip bytes']);
    vi.spyOn(agentApi, 'bulkExportArticles').mockResolvedValue(blob);
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn().mockReturnValue('blob:mock'),
      revokeObjectURL: vi.fn(),
    });

    renderWithClient(
      <ArticleTable token="tok" selectedId={null} onSelect={() => {}} onNew={() => {}} />,
    );

    (await screen.findByLabelText('Select Refund Policy')).click();
    (await screen.findByRole('button', { name: 'Export' })).click();

    await waitFor(() => expect(agentApi.bulkExportArticles).toHaveBeenCalledWith('tok', ['art-1']));

    vi.unstubAllGlobals();
  });

  it('asks for confirmation before publishing, then publishes each selected article', async () => {
    vi.spyOn(agentApi, 'fetchArticles').mockResolvedValue({ articles: TWO_ARTICLES });
    const publishSpy = vi.spyOn(agentApi, 'publishArticle').mockResolvedValue({} as never);

    renderWithClient(
      <ArticleTable token="tok" selectedId={null} onSelect={() => {}} onNew={() => {}} />,
    );

    (await screen.findByLabelText('Select Refund Policy')).click();
    (await screen.findByLabelText('Select Getting Started')).click();
    (await screen.findByRole('button', { name: 'Publish' })).click();

    // Clicking the toolbar's Publish only opens the confirm dialog — nothing
    // should have been published yet.
    const dialogTitle = await screen.findByText('Publish 2 articles?');
    expect(publishSpy).not.toHaveBeenCalled();

    const dialog = dialogTitle.closest('[role="dialog"]') ?? document.body;
    within(dialog).getByRole('button', { name: 'Publish' }).click();

    await waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(2));
    expect(publishSpy).toHaveBeenCalledWith('tok', 'art-1');
    expect(publishSpy).toHaveBeenCalledWith('tok', 'art-2');
    await waitFor(() => expect(screen.queryByText(/selected/)).not.toBeInTheDocument());
  });

  it('disables bulk Archive once every selected article is already archived', async () => {
    vi.spyOn(agentApi, 'fetchArticles').mockResolvedValue({
      articles: [{ ...TWO_ARTICLES[0]!, state: 'archived' }],
    });

    renderWithClient(
      <ArticleTable token="tok" selectedId={null} onSelect={() => {}} onNew={() => {}} />,
    );

    (await screen.findByLabelText('Select Refund Policy')).click();

    expect(await screen.findByRole('button', { name: 'Archive' })).toBeDisabled();
  });
});
