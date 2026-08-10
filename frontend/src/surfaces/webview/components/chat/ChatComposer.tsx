import { useState } from 'react'
import { SendHorizontal } from 'lucide-react'
import { cn } from '@/surfaces/webview/lib/cn'

/**
 * Same behaviour as features/chat/components/Composer.tsx — trim, ignore empty,
 * Enter sends and Shift+Enter newlines, clear on submit — restyled for the
 * webview and with the visibility toggle removed rather than merely unset.
 *
 * There is no code path for a player to send an internal note. The shared
 * Composer guarantees that by omitting a prop; this one guarantees it by not
 * having the control at all, which is the stronger version of the same rule.
 */
export function ChatComposer({ onSend, disabled }: { onSend: (body: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState('')

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    onSend(trimmed)
    setValue('')
  }

  const empty = value.trim().length === 0

  return (
    <div
      className="flex shrink-0 items-end gap-2 border-t border-muted/15 bg-bg px-3 py-3"
      // The safe-area inset is applied here as well as on the shell frame: this
      // row is the bottom-most thing on screen and must clear the home indicator
      // even while the keyboard is up and the shell's own padding is collapsed.
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
    >
      <textarea
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder="Type a message…"
        aria-label="Message"
        className={cn(
          'max-h-32 min-h-11 flex-1 resize-none rounded-card bg-surface px-4 py-3',
          'text-base text-text placeholder:text-muted',
          'border border-transparent focus:border-accent outline-none',
          'disabled:opacity-60',
        )}
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled === true || empty}
        aria-label="Send message"
        className={cn(
          'inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors outline-none',
          empty || disabled === true ? 'bg-surface text-muted' : 'bg-accent text-accent-fg active:bg-accent-deep',
        )}
      >
        <SendHorizontal className="size-5" />
      </button>
    </div>
  )
}
