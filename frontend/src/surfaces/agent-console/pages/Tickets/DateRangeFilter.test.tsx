import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateRangeFilter } from './DateRangeFilter.tsx';

describe('DateRangeFilter', () => {
  it('shows a placeholder label when no range is set', () => {
    render(<DateRangeFilter from="" to="" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Created date/ })).toBeInTheDocument();
  });

  it('shows the formatted range when both bounds are set', () => {
    render(<DateRangeFilter from="2026-08-01" to="2026-08-15" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Aug 1.*Aug 15/ })).toBeInTheDocument();
  });

  it('selecting a day range calls onChange with YYYY-MM-DD bounds', async () => {
    const onChange = vi.fn();
    render(<DateRangeFilter from="" to="" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Created date/ }));

    const day1 = await screen.findByRole('gridcell', { name: '1' });
    await userEvent.click(day1.querySelector('button')!);
    const day5 = screen.getByRole('gridcell', { name: '5' });
    await userEvent.click(day5.querySelector('button')!);

    expect(onChange).toHaveBeenCalled();
    const [call] = onChange.mock.calls[onChange.mock.calls.length - 1]!;
    expect(call.createdFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(call.createdTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
