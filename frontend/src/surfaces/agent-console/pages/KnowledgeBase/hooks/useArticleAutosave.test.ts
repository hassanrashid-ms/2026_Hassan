import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentApi from '../../../api/agentApi.ts';
import { useArticleAutosave } from './useArticleAutosave.ts';

vi.mock('../../../api/agentApi.ts');

describe('useArticleAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('creates a draft on the first edit, once, even if two fields change close together', async () => {
    vi.mocked(agentApi.createArticle).mockResolvedValue({
      id: 'new-id',
      title: 'T',
      body: '',
      keywords: [],
      state: 'draft',
      intent_id: null,
      created_by: 'a',
      published_by: null,
      published_at: null,
      created_at: new Date().toISOString(),
      attachments: [],
      version: 1,
      draft: null,
    });
    const onCreated = vi.fn();

    const { result, rerender } = renderHook(
      (fields) =>
        useArticleAutosave({ token: 't', articleId: null, mode: 'article', onCreated, fields }),
      { initialProps: { title: '', body: '', keywords: [], intentId: undefined } },
    );

    rerender({ title: 'T', body: '', keywords: [], intentId: undefined });
    rerender({ title: 'T', body: 'B', keywords: [], intentId: undefined });

    expect(result.current.status).toBe('unsaved');

    await act(async () => {
      vi.advanceTimersByTime(800);
    });

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-id'));
    expect(agentApi.createArticle).toHaveBeenCalledTimes(1);
  });

  it('goes unsaved -> saving -> saved for an update on an existing draft', async () => {
    vi.mocked(agentApi.updateArticle).mockResolvedValue({
      id: 'a1',
      title: 'T2',
      body: 'B',
      keywords: [],
      state: 'draft',
      intent_id: null,
      created_by: 'a',
      published_by: null,
      published_at: null,
      created_at: new Date().toISOString(),
      attachments: [],
      version: 1,
      draft: null,
    });

    const { result, rerender } = renderHook(
      (fields) =>
        useArticleAutosave({
          token: 't',
          articleId: 'a1',
          mode: 'article',
          onCreated: vi.fn(),
          fields,
        }),
      { initialProps: { title: 'T', body: 'B', keywords: [], intentId: undefined } },
    );
    expect(result.current.status).toBe('saved');

    rerender({ title: 'T2', body: 'B', keywords: [], intentId: undefined });
    expect(result.current.status).toBe('unsaved');

    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    await waitFor(() => expect(result.current.status).toBe('saved'));
    expect(agentApi.updateArticle).toHaveBeenCalledWith('t', 'a1', {
      title: 'T2',
      body: 'B',
      keywords: [],
      intent_id: null,
    });
  });

  it('ensureArticleId creates synchronously, bypassing the debounce, when there is no id yet', async () => {
    vi.mocked(agentApi.createArticle).mockResolvedValue({
      id: 'new-id',
      title: '',
      body: '',
      keywords: [],
      state: 'draft',
      intent_id: null,
      created_by: 'a',
      published_by: null,
      published_at: null,
      created_at: new Date().toISOString(),
      attachments: [],
      version: 1,
      draft: null,
    });

    const { result } = renderHook(() =>
      useArticleAutosave({
        token: 't',
        articleId: null,
        mode: 'article',
        onCreated: vi.fn(),
        fields: { title: '', body: '', keywords: [], intentId: undefined },
      }),
    );

    const id = await act(() => result.current.ensureArticleId());
    expect(id).toBe('new-id');
    expect(agentApi.createArticle).toHaveBeenCalledTimes(1);
  });
});
