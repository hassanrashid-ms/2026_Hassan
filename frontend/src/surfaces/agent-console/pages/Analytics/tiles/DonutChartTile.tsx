import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { TileFrame } from './TileFrame.tsx'
import { paletteColor } from './chartPalette.ts'

type DonutChartTileProps = {
  title: string
  data: Array<{ label: string; value: number }>
}

export function DonutChartTile({ title, data }: DonutChartTileProps) {
  return (
    <TileFrame title={title}>
      {data.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-muted">No data in this range</div>
      ) : (
        <div className="flex h-full items-center gap-3">
          <ResponsiveContainer width="60%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="label" innerRadius="55%" outerRadius="80%">
                {data.map((entry, i) => (
                  <Cell key={entry.label} fill={paletteColor(i)} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <ul className="flex-1 space-y-1 text-xs">
            {data.map((entry, i) => (
              <li key={entry.label} className="flex items-center gap-1.5 text-muted">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: paletteColor(i) }} />
                <span>{entry.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </TileFrame>
  )
}
