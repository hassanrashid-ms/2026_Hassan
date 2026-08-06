import { useState } from 'react'

type ComposerProps = {
  onSend: (body: string) => void
  disabled?: boolean
}

export function Composer({ onSend, disabled }: ComposerProps) {
  const [value, setValue] = useState('')

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    onSend(trimmed)
    setValue('')
  }

  return (
    <div className="composer">
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
