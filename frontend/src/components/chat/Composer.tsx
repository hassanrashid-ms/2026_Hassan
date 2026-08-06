import { useState } from 'react'

type ComposerProps = {
  onSend: (body: string, visibility?: 'public' | 'internal') => void
  disabled?: boolean
  /** Only the agent console passes this. The player surface's Composer usage omits it, so
   *  onSend is always called with visibility undefined there — there is no code path for a
   *  player to send an internal note. */
  allowVisibilityToggle?: boolean
}

export function Composer({ onSend, disabled, allowVisibilityToggle }: ComposerProps) {
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
    <div className="composer">
      {allowVisibilityToggle && (
        <div className="composer__visibility" role="radiogroup" aria-label="Message visibility">
          <button type="button" aria-pressed={visibility === 'public'} onClick={() => setVisibility('public')}>
            Public
          </button>
          <button type="button" aria-pressed={visibility === 'internal'} onClick={() => setVisibility('internal')}>
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
        placeholder="Type a message…"
      />
      <button type="button" onClick={submit} disabled={disabled === true || value.trim().length === 0}>
        Send
      </button>
    </div>
  )
}
