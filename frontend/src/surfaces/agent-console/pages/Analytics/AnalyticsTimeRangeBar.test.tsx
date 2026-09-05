import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { differenceInCalendarDays } from 'date-fns';
import { AnalyticsTimeRangeBar } from './AnalyticsTimeRangeBar.tsx';

describe('AnalyticsTimeRangeBar', () => {
  it('calls onChange with a 7-day range when the 7d preset is clicked', async () => {
    const onChange = vi.fn();
    render(
      <AnalyticsTimeRangeBar
        value={{ from: new Date('2026-08-01'), to: new Date('2026-08-31') }}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '7d' }));

    expect(onChange).toHaveBeenCalled();
    const [{ from, to }] = onChange.mock.calls[0]!;
    expect(differenceInCalendarDays(to, from)).toBe(7);
  });

  it('renders all four presets', () => {
    render(
      <AnalyticsTimeRangeBar value={{ from: new Date(), to: new Date() }} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7d' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30d' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '90d' })).toBeInTheDocument();
  });
});
