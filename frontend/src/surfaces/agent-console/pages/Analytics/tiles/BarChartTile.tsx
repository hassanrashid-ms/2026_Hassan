import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { TileFrame } from './TileFrame.tsx'
import { paletteColor } from './chartPalette.ts'

type BarChartTileProps = {
  title: string
  data: Array<{ label: string; value: number }>
  onRemove?: () => void
}

export function BarChartTile({ title, data, onRemove }: BarChartTileProps) {
  return (
    <TileFrame title={title} onRemove={onRemove}>
      {data.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-muted">No data in this range</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-muted)" />
            <YAxis tick={{ fontSize: 11 }} stroke="var(--color-muted)" />
            <Tooltip />
            <Bar dataKey="value" fill={paletteColor(0)} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </TileFrame>
  )
}
