import type { AgentConversationContextResponse, AgentTicketSummary } from '@support/types';
import { cn } from '../../../../lib/cn.ts';
import { ticketOutcome } from './ticketOutcome.ts';

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function summaryLine(summary: AgentConversationContextResponse['summary']): string {
  // total_tickets counts earlier tickets only, so zero means this is the first
  // one — "0 earlier tickets" reads as an error rather than a first contact.
  if (summary.total_tickets === 0) return `First contact ${shortDate(summary.first_contact_at)}`;
  const parts = [
    `${summary.total_tickets} earlier ticket${summary.total_tickets === 1 ? '' : 's'}`,
  ];
  if (summary.total_reopened > 0) parts.push(`${summary.total_reopened} reopened`);
  parts.push(`first contact ${shortDate(summary.first_contact_at)}`);
  return parts.join(' · ');
}

export function TicketList({
  tickets,
  summary,
  currentId,
  onSelect,
}: {
  tickets: AgentTicketSummary[];
  summary: AgentConversationContextResponse['summary'];
  currentId: string;
  onSelect: (id: string) => void;
}) {
  // Newest first, sorted here rather than trusted from the payload: this list is
  // read as a timeline and a mis-ordered row misreads as a different history.
  const ordered = [...tickets].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <section className="px-4 py-3">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Tickets</h3>
      <p className="mt-1 text-xs text-muted">{summaryLine(summary)}</p>
      <ul className="mt-2 flex flex-col">
        {ordered.map((ticket) => {
          const isCurrent = ticket.id === currentId;
          return (
            <li key={ticket.id}>
              <button
                type="button"
                // The current row stays clickable: navigating to where you
                // already are is a harmless no-op, and a dead row reads broken.
                onClick={() => onSelect(ticket.id)}
                aria-current={isCurrent ? 'true' : undefined}
                className={cn(
                  'flex w-full flex-col gap-0.5 border-b border-l-2 border-slate-100 px-2 py-2 text-left transition-colors',
                  isCurrent
                    ? 'border-l-accent bg-accent-soft font-medium'
                    : 'border-l-transparent hover:bg-accent-soft/50',
                )}
              >
                <span className="flex items-baseline justify-between gap-2 text-sm text-text">
                  <span className="font-medium">
                    #{ticket.number}
                    {isCurrent ? (
                      <span className="ml-2 text-xs font-normal text-accent">Viewing</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    {shortDate(ticket.created_at)}
                  </span>
                </span>
                <span className="truncate text-xs text-muted">
                  {ticket.subintent?.subintent_name ?? 'No subintent'}
                </span>
                <span className="text-xs text-muted">
                  {ticketOutcome(
                    ticket.status,
                    ticket.resolution_source,
                    ticket.resolved_by_agent_name,
                    ticket.reopen_count,
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
