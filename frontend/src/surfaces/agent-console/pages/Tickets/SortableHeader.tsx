import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn } from '../../lib/cn.ts';

export type SortState = {
  primary: string;
  primaryDir: 'asc' | 'desc';
  secondary: string;
  secondaryDir: 'asc' | 'desc';
};

export function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (next: SortState) => void;
  className?: string;
}) {
  const isPrimary = sort.primary === sortKey;
  const isSecondary = sort.secondary === sortKey;
  const dir = isPrimary ? sort.primaryDir : isSecondary ? sort.secondaryDir : null;

  function handleClick() {
    if (isPrimary) {
      onSort({ ...sort, primaryDir: sort.primaryDir === 'asc' ? 'desc' : 'asc' });
      return;
    }
    if (isSecondary) {
      onSort({ ...sort, secondaryDir: sort.secondaryDir === 'asc' ? 'desc' : 'asc' });
      return;
    }
    // Not active: promote to primary, demote the old primary to secondary,
    // drop the old secondary — the 2-key cap.
    onSort({
      primary: sortKey,
      primaryDir: 'asc',
      secondary: sort.primary,
      secondaryDir: sort.primaryDir,
    });
  }

  return (
    <th className={cn('px-4 py-2.5', className)}>
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex items-center gap-1 hover:text-text"
      >
        {label}
        {dir && (
          <span
            aria-label={`sorted ${dir === 'asc' ? 'ascending' : 'descending'}, ${isPrimary ? 'primary' : 'secondary'}`}
            aria-hidden="true"
            className={cn(isPrimary ? 'text-text' : 'text-muted')}
          >
            {dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
          </span>
        )}
      </button>
    </th>
  );
}
