import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicArticleSummary } from '@support/types';
import { SupportHome } from './SupportHome.tsx';
import {
  SupportContextProvider,
  type SupportContextValue,
} from '@/surfaces/webview/components/SupportContext.tsx';
import { makeBootstrapResponse } from '@/surfaces/webview/test-support/fixtures.ts';
import { fetchArticleDetail, fetchArticles, fetchIntents } from '@/surfaces/webview/api/surfaceApi';

vi.mock('@/surfaces/webview/api/surfaceApi');

function renderHome(value: SupportContextValue) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/embed/support']}>
        <SupportContextProvider value={value}>
          <SupportHome />
        </SupportContextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const contextValue: SupportContextValue = {
  boot: { token: 't', sessionId: 's', entryPoint: 'test' },
  data: makeBootstrapResponse(),
  error: null,
  retry: vi.fn(),
};

beforeEach(() => {
  vi.mocked(fetchIntents).mockResolvedValue({ intents: [] });
  vi.mocked(fetchArticleDetail).mockResolvedValue({
    id: 'harmless',
    title: 'harmless',
    body: 'harmless',
    keywords: [],
    intent_id: null,
    published_at: null,
  });
});

describe('SupportHome', () => {
  it('renders articles in exactly the order the API returned — never re-sorted client-side', async () => {
    // Deliberately neither alphabetical nor id-sorted, in either direction, so a
    // stray .sort() on title or id would visibly break this assertion.
    const apiArticles: PublicArticleSummary[] = [
      { id: 'b-id', title: 'Zebra stripes', keywords: [], intent_id: null },
      { id: 'z-id', title: 'Apple crash', keywords: [], intent_id: null },
      { id: 'a-id', title: 'Mango login', keywords: [], intent_id: null },
    ];
    vi.mocked(fetchArticles).mockResolvedValue({ articles: apiArticles });

    renderHome(contextValue);

    await waitFor(() => expect(screen.getByText('Mango login')).toBeInTheDocument());

    const titleTexts = apiArticles.map((article) => article.title);
    const renderedTitles = screen
      .getAllByText((content) => titleTexts.includes(content))
      .map((node) => node.textContent);

    expect(renderedTitles).toEqual(titleTexts);
  });

  it('shows the empty state, not a filtered list, when the API returns no articles', async () => {
    vi.mocked(fetchArticles).mockResolvedValue({ articles: [] });

    renderHome(contextValue);

    expect(await screen.findByText('No articles yet')).toBeInTheDocument();
  });
});
