import { Skeleton } from './ui/skeleton.tsx';

/**
 * Shown in the content area the instant a nav item is clicked, while that
 * tab's lazy chunk loads — the shell (sidebar/header) never unmounts, so the
 * click itself always feels instant even though the page behind it hasn't
 * arrived yet.
 */
export function PageSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <Skeleton className="h-6 w-40" />
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full shrink-0" />
        ))}
      </div>
    </div>
  );
}
