type TileSkeletonProps = { kind: 'number' | 'chart' }

export function TileSkeleton({ kind }: TileSkeletonProps) {
  return (
    <div className="flex h-full flex-col rounded-card border border-accent-soft bg-surface p-3">
      <div className="mb-2 h-4 w-24 animate-pulse rounded bg-accent-soft" />
      {kind === 'number' ? (
        <div className="h-8 w-16 animate-pulse rounded bg-accent-soft" />
      ) : (
        <div className="min-h-0 flex-1 animate-pulse rounded bg-accent-soft" />
      )}
    </div>
  )
}
