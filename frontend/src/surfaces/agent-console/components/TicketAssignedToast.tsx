import { X } from 'lucide-react';

type TicketAssignedToastProps = {
  ticketNumber: number | null;
  workspaceName: string | null;
  onOpen: () => void;
  onDismiss: () => void;
};

/**
 * Rendered via `toast.custom` rather than plain `toast()` — sonner's built-in
 * toast has no click handler of its own, only `action`/`cancel` buttons, so a
 * "click anywhere on the toast to open the ticket" affordance needs a fully
 * custom body. `toast.custom` also suppresses sonner's own close button
 * (`closeButton && !toast.jsx`), so this renders one itself, stopping
 * propagation before dismissing so closing never also navigates.
 */
export function TicketAssignedToast({
  ticketNumber,
  workspaceName,
  onOpen,
  onDismiss,
}: TicketAssignedToastProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onOpen();
      }}
      className="relative flex w-full max-w-[364px] cursor-pointer items-start gap-3 rounded-lg bg-accent p-4 pr-9 text-accent-fg shadow-lg"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {ticketNumber
            ? `Ticket #${ticketNumber} assigned to you`
            : 'A ticket was assigned to you'}
        </p>
        {workspaceName && <p className="text-sm text-accent-fg/85">in {workspaceName}</p>}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
        className="absolute right-2 top-2 rounded-full p-1 text-accent-fg/80 hover:bg-black/10 hover:text-accent-fg"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
