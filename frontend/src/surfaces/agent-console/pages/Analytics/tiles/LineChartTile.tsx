import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { TileFrame } from './TileFrame.tsx'
import { paletteColor } from './chartPalette.ts'

type LineChartTileProps = {
  title: string
  series: Array<{ bucket: string; [key: string]: string | number }>
  dataKeys: string[]
}

export function LineChartTile({ title, series, dataKeys }: LineChartTileProps) {
  return (
    <TileFrame title={title}>
      {series.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-muted">No data in this range</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series}>
            <XAxis dataKey="bucket" tick={{ fontSize: 11 }} stroke="var(--color-muted)" />
            <YAxis tick={{ fontSize: 11 }} stroke="var(--color-muted)" />
            <Tooltip />
            {dataKeys.map((key, i) => (
              <Line key={key} type="monotone" dataKey={key} stroke={paletteColor(i)} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </TileFrame>
  )
}
