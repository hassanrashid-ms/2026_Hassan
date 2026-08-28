import { Check } from 'lucide-react';
import type { ChatDeliveryState } from '@support/types';

/**
 * One grey tick: the server has the message. Two blue ticks: the other side read it.
 *
 * Styled with bare Tailwind utilities and `currentColor` since this component is
 * shared and each surface defines its own tokens in its own scoped stylesheet.
 *
 * The read colour is a prop rather than a token because the two surfaces render
 * these ticks against different backgrounds: the webview puts them on the page
 * background below the bubble, the agent console puts them inside a slate-600
 * bubble. One blue cannot be legible on both, and blue is the whole signal.
 */
export function DeliveryTicks({
  deliveryState,
  readClassName = 'text-sky-500',
}: {
  deliveryState?: ChatDeliveryState;
  readClassName?: string;
}) {
  if (deliveryState !== 'sent' && deliveryState !== 'delivered' && deliveryState !== 'read')
    return null;

  // 'delivered' is never written by any code path (see the spec's Out of scope).
  const read = deliveryState === 'read';

  return (
    <span className={read ? readClassName : 'opacity-70'}>
      <span className="inline-flex items-center align-middle" aria-hidden="true">
        <Check className="size-3.5" strokeWidth={3} />
        {read && <Check className="-ml-2 size-3.5" strokeWidth={3} />}
      </span>
      {/* Colour is never the only carrier of the signal. */}
      <span className="sr-only">{read ? 'Seen' : 'Sent'}</span>
    </span>
  );
}
