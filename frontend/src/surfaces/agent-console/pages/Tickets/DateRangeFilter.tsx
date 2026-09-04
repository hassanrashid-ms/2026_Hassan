import { format } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { Button } from '../../components/ui/button.tsx';
import { Calendar } from '../../components/ui/calendar.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.tsx';

/** Local YYYY-MM-DD, matching the wire format already used by createdFrom/createdTo. */
function toLocalDateString(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function fromLocalDateString(value: string): Date | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year!, month! - 1, day!);
}

function triggerLabel(from: string, to: string): string {
  if (!from && !to) return 'Created date';
  if (from && to) return `${format(fromLocalDateString(from)!, 'MMM d')} – ${format(fromLocalDateString(to)!, 'MMM d')}`;
  if (from) return `From ${format(fromLocalDateString(from)!, 'MMM d')}`;
  return `Until ${format(fromLocalDateString(to)!, 'MMM d')}`;
}

export function DateRangeFilter({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (next: { createdFrom: string; createdTo: string }) => void;
}) {
  const selected: DateRange | undefined =
    from || to ? { from: fromLocalDateString(from), to: fromLocalDateString(to) } : undefined;

  function handleSelect(range: DateRange | undefined) {
    onChange({
      createdFrom: range?.from ? toLocalDateString(range.from) : '',
      createdTo: range?.to ? toLocalDateString(range.to) : '',
    });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {triggerLabel(from, to)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0" align="start">
        <Calendar mode="range" selected={selected} onSelect={handleSelect} />
      </PopoverContent>
    </Popover>
  );
}
