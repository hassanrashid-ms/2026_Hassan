import { useState } from 'react'

type ComposerProps = {
  onSend: (body: string, visibility?: 'public' | 'internal') => void
  disabled?: boolean
  /** Only the agent console passes this. The player surface's Composer usage omits it, so
   *  onSend is always called with visibility undefined there — there is no code path for a
   *  player to send an internal note. */
  allowVisibilityToggle?: boolean
  /** Defaults to today's copy, so the webview surface is untouched. */
  placeholder?: string
}

/**
 * Styled with bare Tailwind utilities against the --color-* tokens rather than
 * a semantic classname — shared across surfaces, each of which defines those
 * tokens differently in its own scoped stylesheet (see ChatThread.tsx).
 */
export function Composer({ onSend, disabled, allowVisibilityToggle, placeholder = 'Type a message…' }: ComposerProps) {
  const [value, setValue] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'internal'>('public')

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    onSend(trimmed, allowVisibilityToggle ? visibility : undefined)
    setValue('')
    setVisibility('public')
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-muted/20 bg-bg p-2">
      {allowVisibilityToggle && (
        <div className="flex shrink-0 gap-1" role="radiogroup" aria-label="Message visibility">
          <button
            type="button"
            aria-pressed={visibility === 'public'}
            onClick={() => setVisibility('public')}
            className={
              visibility === 'public'
                ? 'rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg'
                : 'rounded-md bg-accent-soft px-2 py-1 text-xs font-medium text-muted'
            }
          >
            Public
          </button>
          <button
            type="button"
            aria-pressed={visibility === 'internal'}
            onClick={() => setVisibility('internal')}
            className={
              visibility === 'internal'
                ? 'rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg'
                : 'rounded-md bg-accent-soft px-2 py-1 text-xs font-medium text-muted'
            }
          >
            Internal
          </button>
        </div>
      )}
      <textarea
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder={placeholder}
        // The visibility toggle above is labelled; this had no accessible name
        // at all, which the webview's own composer has always carried.
        aria-label="Message"
        className="min-h-9 max-h-24 flex-1 resize-none rounded-md border border-muted/20 bg-accent-soft px-3 py-1.5 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled === true || value.trim().length === 0}
        className="h-9 shrink-0 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:pointer-events-none disabled:opacity-50"
      >
        Send
      </button>
    </div>
  )
}
