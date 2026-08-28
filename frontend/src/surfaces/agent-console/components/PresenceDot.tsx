import { cn } from '../lib/cn.ts';
import type { DisplayStatus } from '../api/agentApi.ts';

export type { DisplayStatus };

// 🟢 online, 🟡 away, ⚪ offline, 🔵 on_leave — see
// docs/specs/2026-08-24-agent-presence-status-design.md.
const STATUS_COLOR: Record<DisplayStatus, string> = {
  online: 'bg-green-500',
  away: 'bg-yellow-500',
  offline: 'bg-slate-300',
  on_leave: 'bg-blue-500',
};

/**
 * Small corner badge meant to sit on top of an Avatar (absolutely
 * positioned by the caller) or inline next to a name.
 */
export function PresenceDot({ status, className }: { status: DisplayStatus; className?: string }) {
  return (
    <span
      data-testid="presence-dot"
      data-status={status}
      aria-label={`Status: ${status.replace('_', ' ')}`}
      className={cn('block size-2.5 rounded-full ring-2 ring-bg', STATUS_COLOR[status], className)}
    />
  );
}
