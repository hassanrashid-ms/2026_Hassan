import { useState } from 'react'
import { subDays, startOfDay } from 'date-fns'
import type { DateRange } from 'react-day-picker'
import { Button } from '../../components/ui/button.tsx'
import { Calendar } from '../../components/ui/calendar.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.tsx'

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
  const [open, setOpen] = useState(false)

  return (
    <div className="flex items-center gap-2">
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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" className="h-8 px-3 text-sm">
            Custom
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="range"
            selected={{ from: value.from, to: value.to } satisfies DateRange}
            onSelect={(range) => {
              if (range?.from && range?.to) {
                onChange({ from: range.from, to: range.to })
                setOpen(false)
              }
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
