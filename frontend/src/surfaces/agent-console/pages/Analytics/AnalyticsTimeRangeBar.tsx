import { useState } from 'react'
import { subDays, startOfDay } from 'date-fns'
import { DayPicker } from 'react-day-picker'
import { Button } from '../../components/ui/button.tsx'

type Range = { from: Date; to: Date }

type AnalyticsTimeRangeBarProps = {
  value: Range
  onChange: (range: Range) => void
}

const PRESETS: Array<{ label: string; days: number }> = [
  { label: 'Today', days: 0 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
]

export function AnalyticsTimeRangeBar({ value, onChange }: AnalyticsTimeRangeBarProps) {
  const [showCustom, setShowCustom] = useState(false)

  return (
    <div className="relative flex items-center gap-2">
      {PRESETS.map((preset) => (
        <Button
          key={preset.label}
          type="button"
          variant="ghost"
          className="h-8 px-3 text-sm"
          onClick={() => onChange({ from: startOfDay(subDays(new Date(), preset.days)), to: new Date() })}
        >
          {preset.label}
        </Button>
      ))}
      <Button type="button" variant="ghost" className="h-8 px-3 text-sm" onClick={() => setShowCustom((s) => !s)}>
        Custom
      </Button>
      {showCustom && (
        <div className="absolute top-full right-0 z-10 mt-2 rounded-card border border-accent-soft bg-surface p-2 shadow-md">
          <DayPicker
            mode="range"
            selected={{ from: value.from, to: value.to }}
            onSelect={(range) => {
              if (range?.from && range?.to) {
                onChange({ from: range.from, to: range.to })
                setShowCustom(false)
              }
            }}
          />
        </div>
      )}
    </div>
  )
}
