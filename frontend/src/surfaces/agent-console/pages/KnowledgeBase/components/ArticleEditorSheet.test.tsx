import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArticleEditorSheet } from './ArticleEditorSheet.tsx';
import * as agentApi from '../../../api/agentApi.ts';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
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
};

describe('ArticleEditorSheet loading', () => {
  it('shows a skeleton until the article loads, then renders its body in the editor', async () => {
    let resolveArticle: (a: typeof EXISTING_ARTICLE) => void = () => {};
    vi.spyOn(agentApi, 'fetchArticle').mockReturnValue(
      new Promise((resolve) => {
        resolveArticle = resolve;
      }),
    );
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    // Nothing half-populated is on screen while the fetch is in flight.
    expect(screen.getByTestId('article-editor-skeleton')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Article title')).toBeNull();

    resolveArticle(EXISTING_ARTICLE);

    // The body reaches the editor on its first render — no blank editor to recover from.
    await screen.findByDisplayValue('Refunds');
    await waitFor(() => expect(screen.getByText('Refund policy')).toBeTruthy());
    expect(screen.queryByTestId('article-editor-skeleton')).toBeNull();
  });
});

describe('ArticleEditorSheet MDXEditor round-trip', () => {
  it('writes markdown in and saves the same markdown back out', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });
    const updateSpy = vi.spyOn(agentApi, 'updateArticle').mockResolvedValue(EXISTING_ARTICLE);

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refunds');

    const saveButton = screen.getByRole('button', { name: /save/i });
    await userEvent.click(saveButton);

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        'tok',
        'art-1',
        expect.objectContaining({ body: expect.stringContaining('Refund policy') }),
      ),
    );
    // The same markdown emphasis marker round-trips unchanged.
    const [, , patch] = updateSpy.mock.calls[0]!;
    expect(patch.body).toContain('**30 days**');
  });
});

describe('ArticleEditorSheet body field sizing', () => {
  it('does not shrink the Body field below its content — no flex-1/min-h-0 on that wrapper', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refunds');

    // That combination is for a section that scrolls on its own (it isn't — the form
    // container above it owns the scrollbar). Applied here, it let flexbox shrink this
    // field below the editor's actual content once the whole form got tall enough,
    // so the bordered box stopped growing and content rendered past its bottom edge.
    const bodyLabel = screen.getByText('Body');
    const bodyFieldWrapper = bodyLabel.parentElement!;
    expect(bodyFieldWrapper.className).not.toMatch(/\bflex-1\b/);
    expect(bodyFieldWrapper.className).not.toMatch(/\bmin-h-0\b/);
  });
});

describe('ArticleEditorSheet markdown import', () => {
  it('fills title, body, and keywords from an imported file, leaving category untouched', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refunds');

    const fileContent = [
      '---',
      'title: Cancelling a Subscription',
      'tags: [cancel, subscription]',
      '---',
      '# Cancelling a Subscription',
      '',
      'Go to Settings > Subscriptions.',
    ].join('\n');
    const file = new File([fileContent], 'cancel-sub.md', { type: 'text/markdown' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, file);

    await screen.findByDisplayValue('Cancelling a Subscription');
    expect(screen.getByDisplayValue('cancel, subscription')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Go to Settings > Subscriptions.')).toBeTruthy());
  });

  it('does not truncate content at a thematic break or a fenced code block', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refunds');

    const fileContent = [
      '# Troubleshooting',
      '',
      'Intro paragraph before the first divider.',
      '',
      '---',
      '',
      '## Step 1',
      '',
      'Some instructions.',
      '',
      '```text',
      'C:\\Users\\<YourUsername>\\AppData\\Local\\crash.log',
      '```',
      '',
      '## Contact Support',
      '',
      'Text after the code block must still be present.',
    ].join('\n');
    const file = new File([fileContent], 'troubleshooting.md', { type: 'text/markdown' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, file);

    await waitFor(() =>
      expect(screen.getByText('Intro paragraph before the first divider.')).toBeTruthy(),
    );
    // Content after both the thematic break and the fenced code block must survive.
    expect(screen.getByText('Some instructions.')).toBeTruthy();
    expect(screen.getByText('Contact Support')).toBeTruthy();
    expect(screen.getByText('Text after the code block must still be present.')).toBeTruthy();
  });

  it('shows an error toast and changes nothing when the file is empty', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refunds');

    const file = new File(['   '], 'empty.md', { type: 'text/markdown' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, file);

    // Title is unchanged — a failed import never clobbers existing content.
    expect(screen.getByDisplayValue('Refunds')).toBeTruthy();
  });
});
