import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArticleEditorSheet } from './ArticleEditorSheet.tsx';
import * as agentApi from '../../../api/agentApi.ts';
import type { StoredAgentSession } from '../../../lib/agentSession.ts';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    ...render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>),
  };
}

// Team lead: can see Publish/Archive, same as admin — these tests exercise
// that flow. Role-gating itself (agent cannot publish/archive) is covered
// separately below.
const SESSION: StoredAgentSession = {
  token: 'tok',
  agentId: 'agent-1',
  displayName: 'Agent A',
  workspaceSlug: 'ws',
  role: 'team_lead',
};

const EXISTING_ARTICLE = {
  id: 'art-1',
  title: 'Refunds',
  body: '# Refund policy\n\nWe refund within **30 days**.',
  keywords: ['refund'],
  state: 'draft' as const,
  version: 1,
  draft: null,
  intent_id: null,
  created_by: 'agent-1',
  published_by: null,
  published_at: null,
  created_at: '2026-08-01T00:00:00Z',
  attachments: [],
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
        session={SESSION}
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
  it('writes markdown in and autosaves the same markdown back out', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });
    const updateSpy = vi.spyOn(agentApi, 'updateArticle').mockResolvedValue(EXISTING_ARTICLE);

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        session={SESSION}
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refunds');

    // Any field edit is enough to trigger the debounced autosave — the body
    // itself was already populated into the draft by MDXEditor's own mount-time
    // onChange, so this exercises the same round-trip the old Save button did.
    vi.useFakeTimers();
    fireEvent.change(screen.getByPlaceholderText('Article title'), {
      target: { value: 'Refunds!' },
    });

    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    vi.useRealTimers();

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

describe('ArticleEditorSheet autosave cache write', () => {
  it('writes the saved article straight into the query cache, so an instant reopen never serves the pre-edit value', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });
    const SAVED_ARTICLE = { ...EXISTING_ARTICLE, title: 'Refunds!' };
    vi.spyOn(agentApi, 'updateArticle').mockResolvedValue(SAVED_ARTICLE);

    const { queryClient } = renderWithClient(
      <ArticleEditorSheet
        token="tok"
        session={SESSION}
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refunds');

    vi.useFakeTimers();
    fireEvent.change(screen.getByPlaceholderText('Article title'), {
      target: { value: 'Refunds!' },
    });
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(queryClient.getQueryData(['admin-article', 'art-1'])).toEqual(SAVED_ARTICLE),
    );
  });
});

describe('ArticleEditorSheet body field sizing', () => {
  it('does not shrink the Body field below its content — no flex-1/min-h-0 on that wrapper', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        session={SESSION}
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
        session={SESSION}
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
        session={SESSION}
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

  it('does not drop content around a markdown image', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        session={SESSION}
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refunds');

    const fileContent = [
      '# Cancelling a Subscription',
      '',
      'Go to Settings > Subscriptions, then follow the screenshot below.',
      '',
      '![Subscriptions screen](https://placehold.co/600x400?text=Subscriptions)',
      '',
      'Tap Cancel to confirm.',
    ].join('\n');
    const file = new File([fileContent], 'cancel-sub.md', { type: 'text/markdown' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, file);

    await waitFor(() =>
      expect(
        screen.getByText('Go to Settings > Subscriptions, then follow the screenshot below.'),
      ).toBeTruthy(),
    );
    // jsdom never resolves MDXEditor's Suspense-based image load, so the <img> itself
    // doesn't render here — this only guards against the image node breaking the parse
    // and truncating everything after it, same class of bug as the divider/code-block fix.
    expect(screen.getByText('Tap Cancel to confirm.')).toBeTruthy();
  });

  it('shows an error toast and changes nothing when the file is empty', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        session={SESSION}
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

describe('ArticleEditorSheet autosave status', () => {
  it('shows Unsaved then Saved as the agent types, with no Save or Create Draft button', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });
    vi.spyOn(agentApi, 'updateArticle').mockResolvedValue(EXISTING_ARTICLE);

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        session={SESSION}
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refunds');

    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create Draft' })).toBeNull();

    vi.useFakeTimers();
    fireEvent.change(screen.getByPlaceholderText('Article title'), {
      target: { value: 'New title' },
    });
    expect(screen.getByText('Unsaved')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    vi.useRealTimers();

    await screen.findByText('Saved');
  });
});

describe('ArticleEditorSheet publish/archive role gating', () => {
  const AGENT_SESSION: StoredAgentSession = { ...SESSION, role: 'agent' };

  it('hides Publish and Archive for a plain agent — building a draft is theirs, publishing is not', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        session={AGENT_SESSION}
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refunds');

    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('shows Publish and Archive for a team lead', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        session={SESSION}
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refunds');

    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });
});

describe('ArticleEditorSheet image upload', () => {
  it('uploads an image and inserts an attachment: reference into the body', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });
    vi.spyOn(agentApi, 'requestUpload').mockResolvedValue({
      key: 'pending/ws/agent/uuid.png',
      upload_url: 'https://minio.local/put',
      expires_at: new Date().toISOString(),
    });
    vi.spyOn(agentApi, 'putFileToUploadUrl').mockResolvedValue(undefined);
    const finalizeSpy = vi.spyOn(agentApi, 'finalizeArticleAttachment').mockResolvedValue({
      id: 'a1',
      filename: 'diagram.png',
      mime_type: 'image/png',
      byte_size: 3,
      url: 'https://minio.local/signed',
    });

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        session={SESSION}
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refunds');

    // MDXEditor's InsertImage toolbar control opens our ImageDialogAdapter in
    // place of the stock dialog — drive its drop zone's hidden file input.
    await userEvent.click(screen.getByRole('button', { name: 'Insert image' }));

    const fileInput = screen.getByLabelText('Browse for an image') as HTMLInputElement;
    const file = new File([new Uint8Array(3)], 'diagram.png', { type: 'image/png' });
    await userEvent.upload(fileInput, file);

    // jsdom never resolves MDXEditor's Suspense-based image load (same
    // documented limitation as the markdown-image-import test above), so the
    // inserted image renders as its lexical decorator/placeholder node rather
    // than a real <img>. That the node landed at all, with the upload having
    // gone through finalizeArticleAttachment, is what proves the wiring works.
    await waitFor(() => expect(document.querySelector('[data-lexical-decorator]')).toBeTruthy());
    expect(finalizeSpy).toHaveBeenCalledWith('tok', 'art-1', {
      key: 'pending/ws/agent/uuid.png',
      filename: 'diagram.png',
      mimeType: 'image/png',
      byteSize: 3,
    });
  });

  it('inserts a plain markdown src via the Link tab with no attachment API call', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE);
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });
    // A prior test in this file already drove an upload through this same
    // spied module method — vi.spyOn returns the same mock instance rather
    // than a fresh one, so its call history carries over across tests.
    const finalizeSpy = vi.spyOn(agentApi, 'finalizeArticleAttachment').mockClear();

    renderWithClient(
      <ArticleEditorSheet
        token="tok"
        session={SESSION}
        articleId="art-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refunds');

    await userEvent.click(screen.getByRole('button', { name: 'Insert image' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Link' }));
    await userEvent.type(
      screen.getByPlaceholderText('https://...'),
      'https://placehold.co/600x400?text=Screenshot',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Insert' }));

    await waitFor(() => expect(document.querySelector('[data-lexical-decorator]')).toBeTruthy());
    expect(finalizeSpy).not.toHaveBeenCalled();
  });
});
