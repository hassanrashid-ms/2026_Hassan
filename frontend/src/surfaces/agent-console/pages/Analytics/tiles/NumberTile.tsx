import { TileFrame } from './TileFrame.tsx';

type Format = 'count' | 'percent' | 'duration';

function formatValue(value: number, format: Format): string {
  if (format === 'percent') return `${Math.round(value * 100)}%`;
  if (format === 'duration') {
    const totalSeconds = Math.round(value);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return `${minutes}m ${seconds}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return Math.round(value).toLocaleString();
}

type NumberTileProps = {
  title: string;
  value: number | null;
  format?: Format;
  previousValue?: number | null;
};

export function NumberTile({ title, value, format = 'count', previousValue }: NumberTileProps) {
  const delta = value !== null && previousValue != null ? value - previousValue : null;

  return (
    <TileFrame title={title}>
      <div className="flex h-full flex-col items-center justify-center text-center">
        <span className="text-2xl font-semibold text-text">
          {value === null ? '—' : formatValue(value, format)}
        </span>
        {delta !== null && (
          <span className={delta >= 0 ? 'text-xs text-emerald-600' : 'text-xs text-red-600'}>
            {delta >= 0 ? '+' : ''}
            {format === 'percent'
              ? `${Math.round(delta * 100)}%`
              : Math.round(delta).toLocaleString()}
          </span>
        )}
      </div>
    </TileFrame>
  );
}
