import { useEffect, useState } from 'react';

export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'closing soon';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `closes in ${days}d ${hours}h`;
  if (hours > 0) return `closes in ${hours}h ${minutes}m`;
  return `closes in ${minutes}m`;
}

/**
 * Client-side-only countdown: the deadline is computed once from data
 * already on the conversation-detail response, then re-formatted on a 60s
 * tick — no extra network calls, no server-pushed updates.
 */
export function useAutoCloseCountdown(
  resolvedAt: string | null | undefined,
  autoCloseDays: number | undefined,
): string | null {
  const deadline =
    resolvedAt && autoCloseDays ? new Date(resolvedAt).getTime() + autoCloseDays * 86_400_000 : null;

  const [label, setLabel] = useState<string | null>(() =>
    deadline === null ? null : formatCountdown(deadline - Date.now()),
  );

  useEffect(() => {
    if (deadline === null) {
      setLabel(null);
      return;
    }
    const tick = () => setLabel(formatCountdown(deadline - Date.now()));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [deadline]);

  return label;
}
