import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { formatCountdown, useAutoCloseCountdown } from './autoCloseCountdown.ts';

describe('formatCountdown', () => {
  it('shows days and hours when a day or more remains', () => {
    const ms = 6 * 86_400_000 + 4 * 3_600_000 + 12 * 60_000;
    expect(formatCountdown(ms)).toBe('closes in 6d 4h');
  });

  it('shows hours and minutes under a day', () => {
    const ms = 3 * 3_600_000 + 12 * 60_000;
    expect(formatCountdown(ms)).toBe('closes in 3h 12m');
  });

  it('shows minutes only under an hour', () => {
    expect(formatCountdown(5 * 60_000)).toBe('closes in 5m');
  });

  it('reads "closing soon" at or past the deadline', () => {
    expect(formatCountdown(0)).toBe('closing soon');
    expect(formatCountdown(-1000)).toBe('closing soon');
  });
});

describe('useAutoCloseCountdown', () => {
  it('returns null when resolvedAt or autoCloseDays is missing', () => {
    expect(renderHook(() => useAutoCloseCountdown(null, 7)).result.current).toBeNull();
    expect(
      renderHook(() => useAutoCloseCountdown('2026-08-30T00:00:00.000Z', undefined)).result.current,
    ).toBeNull();
  });

  it('computes the deadline from resolvedAt + autoCloseDays and ticks on a 60s interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'));

    // resolvedAt is 3 days ago, autoCloseDays is 7 -> 4 days remain.
    const { result } = renderHook(() => useAutoCloseCountdown('2026-08-30T00:00:00.000Z', 7));
    expect(result.current).toBe('closes in 4d 0h');

    act(() => {
      vi.setSystemTime(new Date('2026-09-02T00:01:00.000Z'));
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe('closes in 3d 23h');

    vi.useRealTimers();
  });
});
