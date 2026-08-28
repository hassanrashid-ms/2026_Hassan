import { useSearchParams } from 'react-router-dom';

export type TicketsFilters = {
  q: string;
  priority: string[];
  labelIds: string[];
  subintentIds: string[];
  assigneeIds: string[];
  olderThanHours: string;
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
    setParams(nextParams, { replace: true });
  }

  return [filters, update];
}
