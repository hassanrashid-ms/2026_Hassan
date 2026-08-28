import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TagPicker } from './TagPicker.tsx';
import { attachTag, createTag, fetchTags } from '../../../api/agentApi.ts';

vi.mock('../../../api/agentApi.ts');

function renderPicker(attachedTagIds: string[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TagPicker token="t" conversationId="c1" attachedTagIds={attachedTagIds} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TagPicker', () => {
  it('attaches an existing result when selected', async () => {
    vi.mocked(fetchTags).mockResolvedValue([{ id: 'tag-1', name: 'Billing', colorIndex: 0 }]);
    vi.mocked(attachTag).mockResolvedValue({ ok: true });

    renderPicker();

    await userEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    await screen.findByText('Billing');

    await userEvent.click(screen.getByText('Billing'));

    await waitFor(() => expect(attachTag).toHaveBeenCalledWith('t', 'c1', 'tag-1'));
  });

  it('excludes already-attached tags from the results', async () => {
    vi.mocked(fetchTags).mockResolvedValue([
      { id: 'tag-1', name: 'Billing', colorIndex: 0 },
      { id: 'tag-2', name: 'Bug', colorIndex: 1 },
    ]);

    renderPicker(['tag-1']);

    await userEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    await screen.findByText('Bug');

    expect(screen.queryByText('Billing')).not.toBeInTheDocument();
  });

  it('creates then attaches a tag when no result matches the typed name', async () => {
    vi.mocked(fetchTags).mockResolvedValue([]);
    vi.mocked(createTag).mockResolvedValue({ id: 'tag-new', name: 'Refund', colorIndex: 2 });
    vi.mocked(attachTag).mockResolvedValue({ ok: true });

    renderPicker();

    await userEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    const input = await screen.findByPlaceholderText('Search tags...');
    await userEvent.type(input, 'Refund');

    const createRow = await screen.findByText('Create "Refund"');
    await userEvent.click(createRow);

    await waitFor(() => expect(createTag).toHaveBeenCalledWith('t', 'Refund'));
    await waitFor(() => expect(attachTag).toHaveBeenCalledWith('t', 'c1', 'tag-new'));
  });
});
