import { useEffect, type ReactNode } from 'react'
import type { PlayerStateAvailability } from '@support/types'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/surfaces/webview/components/ui/dialog'
import { useSupport } from '@/surfaces/webview/components/SupportContext'

/** British spelling throughout, per the spec's own copy. */
const AVAILABILITY_COPY: Record<PlayerStateAvailability, string> = {
  ok: 'Player state received.',
  degraded: 'Player state is partial — the game could not read every field.',
  missing: 'Player state was delivered but the game returned nothing usable.',
  absent: 'Player state has not arrived yet. It may still be queued on the device.',
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-b border-muted/15 py-2 last:border-b-0">
      <dt className="text-xs font-medium tracking-wide text-muted uppercase">{label}</dt>
      <dd className="min-w-0 text-sm break-all text-text">{children}</dd>
    </div>
  )
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="mt-1 max-w-full max-h-56 overflow-auto rounded-card bg-surface p-3 text-xs leading-relaxed whitespace-pre text-text">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

/**
 * Today's diagnostic panel, relocated and restyled — not redesigned. It was the
 * first thing on the player's screen; it is now behind the ⋯ in the top bar,
 * where it belongs, and where it is still one tap away in the field.
 *
 * Rendered in production. `state.raw` is PII by default, but the person reading
 * it here is the player whose data it is, and a session id the player can read
 * aloud is a support feature, not a leak.
 */
export function DebugDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { boot, data, error } = useSupport()

  useEffect(() => {
    if (!open) return
    window.history.pushState({ debugModal: true }, '')
    const onPopState = () => onOpenChange(false)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [open, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={(newOpen) => {
      if (!newOpen && open) {
        window.history.back()
      } else {
        onOpenChange(newOpen)
      }
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Session details</DialogTitle>
          <DialogDescription>Useful if you contact us about this conversation.</DialogDescription>
        </DialogHeader>

        <dl className="px-1">
          <Row label="Session">{data?.session.id ?? boot?.sessionId ?? 'not started'}</Row>
          <Row label="Opened from">{data?.session.entry_point ?? boot?.entryPoint ?? 'unknown'}</Row>
          <Row label="Started">{data?.session.started_at ?? 'not started'}</Row>
          <Row label="Player">{data?.player.external_player_id ?? 'unknown'}</Row>
          <Row label="Unread replies">{data?.unread_count ?? 0}</Row>

          {error !== null && <Row label="Last error">{error}</Row>}

          {data !== null && (
            <>
              {/* Missing player state is a state, not an error: always a sentence,
                  never a blank panel and never an error page. */}
              <Row label="Player state">{AVAILABILITY_COPY[data.player_state.availability]}</Row>
              {data.player_state.degraded_reason !== null && (
                <Row label="Reason">{data.player_state.degraded_reason}</Row>
              )}
              {/* captured_at is shown prominently on purpose: a reopened conversation
                  keeps its original snapshot, so a six-month-old client version
                  would otherwise read as current. */}
              <Row label="Captured at">{data.player_state.captured_at ?? 'not captured'}</Row>
              <Row label="Declared">
                <Json value={data.player_state.declared} />
              </Row>
              <><Row label="" >Meta</Row></>
              {data.player_state.raw !== undefined && (
                
                <Row label="Freeform">
                  <Json value={data.player_state.raw} />
                </Row>
              )}
            </>
          )}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
