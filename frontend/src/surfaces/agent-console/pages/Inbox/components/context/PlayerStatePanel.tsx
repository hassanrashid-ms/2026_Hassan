import type { AgentPlayerStateView } from '@support/types'

const EMPTY_COPY: Record<'no_session' | 'not_captured' | 'missing', string> = {
  no_session: 'No session was attached to this ticket',
  not_captured: 'No player state was captured',
  missing: 'The game returned no player data',
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export function PlayerStatePanel({ state }: { state: AgentPlayerStateView }) {
  if (state.status !== 'captured') {
    return (
      <section className="px-4 py-3">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Player state</h3>
        <p className="mt-2 text-sm text-muted">{EMPTY_COPY[state.status]}</p>
      </section>
    )
  }

  const hasRaw = Object.keys(state.raw).length > 0

  return (
    <section className="px-4 py-3">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Player state</h3>
      {state.degraded_reason !== null && (
        <p role="note" className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
          Capture was partial: {state.degraded_reason}
        </p>
      )}
      <dl className="mt-2 flex flex-col gap-1.5">
        {state.declared.map((field) => (
          <div key={field.key} className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-xs text-muted">{field.label}</dt>
            <dd className="truncate text-right text-sm text-text">{formatValue(field.value)}</dd>
          </div>
        ))}
      </dl>
      {/* Omitted rather than rendered empty: a disclosure that opens onto `{}`
          reads as a load failure. */}
      {hasRaw && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted">Everything else the game sent</summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-slate-50 p-2 text-xs text-text">
            {JSON.stringify(state.raw, null, 2)}
          </pre>
        </details>
      )}
    </section>
  )
}
