import { useSearchParams } from 'react-router-dom';

export type TicketsFilters = {
  q: string;
  priority: string[];
  labelIds: string[];
  subintentIds: string[];
  assigneeIds: string[];
  olderThanHours: string;
  statuses: string[];
  createdFrom: string;
  createdTo: string;
  view: 'board' | 'list';
  sortBy: string;
  sortDir: 'asc' | 'desc';
  sortBy2: string;
  sortDir2: 'asc' | 'desc';
};

function parseCsv(value: string | null): string[] {
  return value ? value.split(',').filter(Boolean) : [];
}

/**
 * Filter state lives in the URL, not component state — a filtered board is
 * then shareable, bookmarkable, and survives a refresh, matching the pattern
 * already used for search on the webview's SupportSearch page.
 */
export function useTicketsFilters(): [TicketsFilters, (next: Partial<TicketsFilters>) => void] {
  const [params, setParams] = useSearchParams();

  const filters: TicketsFilters = {
    q: params.get('q') ?? '',
    priority: parseCsv(params.get('priority')),
    labelIds: parseCsv(params.get('labelIds')),
    subintentIds: parseCsv(params.get('subintentIds')),
    assigneeIds: parseCsv(params.get('assigneeIds')),
    olderThanHours: params.get('olderThanHours') ?? '',
    statuses: parseCsv(params.get('statuses')),
    createdFrom: params.get('createdFrom') ?? '',
    createdTo: params.get('createdTo') ?? '',
    view: params.get('view') === 'list' ? 'list' : 'board',
    sortBy: params.get('sortBy') ?? 'priority',
    sortDir: params.get('sortDir') === 'desc' ? 'desc' : 'asc',
    sortBy2: params.get('sortBy2') ?? 'created',
    sortDir2: params.get('sortDir2') === 'desc' ? 'desc' : 'asc',
  };

  function update(next: Partial<TicketsFilters>) {
    const merged = { ...filters, ...next };
    const nextParams = new URLSearchParams();
    if (merged.q) nextParams.set('q', merged.q);
    if (merged.priority.length) nextParams.set('priority', merged.priority.join(','));
    if (merged.labelIds.length) nextParams.set('labelIds', merged.labelIds.join(','));
    if (merged.subintentIds.length) nextParams.set('subintentIds', merged.subintentIds.join(','));
    if (merged.assigneeIds.length) nextParams.set('assigneeIds', merged.assigneeIds.join(','));
    if (merged.olderThanHours) nextParams.set('olderThanHours', merged.olderThanHours);
    if (merged.statuses.length) nextParams.set('statuses', merged.statuses.join(','));
    if (merged.createdFrom) nextParams.set('createdFrom', merged.createdFrom);
    if (merged.createdTo) nextParams.set('createdTo', merged.createdTo);
    if (merged.view === 'list') nextParams.set('view', 'list');
    if (merged.sortBy !== 'priority') nextParams.set('sortBy', merged.sortBy);
    if (merged.sortDir !== 'asc') nextParams.set('sortDir', merged.sortDir);
    if (merged.sortBy2 !== 'created') nextParams.set('sortBy2', merged.sortBy2);
    if (merged.sortDir2 !== 'asc') nextParams.set('sortDir2', merged.sortDir2);
    setParams(nextParams, { replace: true });
  }

  return [filters, update];
}
