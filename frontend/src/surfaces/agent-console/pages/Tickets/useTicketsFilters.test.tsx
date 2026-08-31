import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useTicketsFilters } from './useTicketsFilters.ts';

function renderWithRouter(initialEntry: string) {
  return renderHook(() => useTicketsFilters(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
    ),
  });
}

describe('useTicketsFilters', () => {
  it('parses csv params from the URL', () => {
    const { result } = renderWithRouter('/tickets?priority=p1,p2&labelIds=abc');
    const [filters] = result.current;
    expect(filters.priority).toEqual(['p1', 'p2']);
    expect(filters.labelIds).toEqual(['abc']);
    expect(filters.q).toBe('');
  });

  it('defaults to empty filters with no params', () => {
    const { result } = renderWithRouter('/tickets');
    const [filters] = result.current;
    expect(filters).toEqual({
      q: '',
      priority: [],
      labelIds: [],
      subintentIds: [],
      assigneeIds: [],
      olderThanHours: '',
      statuses: [],
      createdFrom: '',
      createdTo: '',
      view: 'board',
    });
  });

  it('merges a partial update into the current filters', () => {
    const { result } = renderWithRouter('/tickets?priority=p1');
    act(() => {
      const [, update] = result.current;
      update({ q: 'refund' });
    });
    const [filters] = result.current;
    expect(filters).toEqual({
      q: 'refund',
      priority: ['p1'],
      labelIds: [],
      subintentIds: [],
      assigneeIds: [],
      olderThanHours: '',
      statuses: [],
      createdFrom: '',
      createdTo: '',
      view: 'board',
    });
  });

  it('drops a filter from the URL when set back to empty', () => {
    const { result } = renderWithRouter('/tickets?priority=p1');
    act(() => {
      const [, update] = result.current;
      update({ priority: [] });
    });
    const [filters] = result.current;
    expect(filters.priority).toEqual([]);
  });

  it('reads and updates the view param', () => {
    const { result } = renderWithRouter('/tickets?view=list');
    expect(result.current[0].view).toBe('list');
    act(() => {
      const [, update] = result.current;
      update({ view: 'board' });
    });
    expect(result.current[0].view).toBe('board');
  });
});
