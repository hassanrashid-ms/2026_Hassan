import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, MessageCircle, MoreHorizontal, Search, X } from 'lucide-react'
import { Input } from '@/surfaces/webview/components/ui/input'
import { useGameName, useSupport } from '@/surfaces/webview/components/SupportContext'
import { cn } from '@/surfaces/webview/lib/cn'
import { post } from '@/services/bridgeService'

export type TopBarVariant =
  | { variant: 'home' }
  | { variant: 'search'; value: string; onValueChange: (value: string) => void }
  | { variant: 'chat' }
  | { variant: 'article'; title: string }

type TopBarProps = TopBarVariant & {
  /** Opens the debug dialog. The ⋯ is rendered on every screen; see below. */
  onOpenDebug: () => void
}

function IconButton({
  label,
  onClick,
  children,
  className,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-full text-accent-fg',
        'transition-colors active:bg-white/20 outline-none',
        className,
      )}
    >
      {children}
    </button>
  )
}

/**
 * Rendered on every screen, in production, at low contrast and small size.
 * A dev-only debug affordance is useless exactly when it is needed: a player is
 * on a device we do not have, and the fastest route to their session id is
 * asking them to tap something that is actually there.
 */
function DebugButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Session details"
      onClick={onClick}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-accent-fg transition-colors active:bg-white/20 outline-none"
    >
      <MoreHorizontal size={24} />
    </button>
  )
}

/**
 * One top bar, four variants. Fixed height, never scrolls, sits above whichever
 * region the screen designates as scrollable.
 */
export function TopBar(props: TopBarProps) {
  const navigate = useNavigate()
  const gameName = useGameName()
  const { data } = useSupport()
  const unread = data?.unread_count ?? 0

  const frame = 'relative flex h-16 shrink-0 items-center gap-1 px-2 bg-accent text-accent-fg'

  if (props.variant === 'search') {
    return (
      <div className={frame}>
        {/* The search bar has no left action — Cancel is the way out — so the
            debug ⋯ takes the otherwise empty corner. */}
        <DebugButton onClick={props.onOpenDebug} />
        <Input
          type="search"
          autoFocus
          enterKeyHint="search"
          aria-label="Search help articles"
          placeholder="Search help"
          value={props.value}
          onChange={(event) => props.onValueChange(event.target.value)}
          className="mx-1 flex-1"
        />
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="shrink-0 rounded-full px-3 py-2 text-base font-semibold text-accent-fg transition-colors active:bg-white/20 outline-none"
        >
          Cancel
        </button>
      </div>
    )
  }

  if (props.variant === 'home') {
    return (
      <div className={frame}>
        {/* ✕ posts the bridge's close message. We hide the UI immediately for
            responsiveness, but wait 500ms to allow pending network requests to finish. */}
        <IconButton
          label="Close support"
          onClick={() => {
            document.body.style.backgroundColor = 'transparent'
            const root = document.getElementById('root')
            if (root) root.style.display = 'none'
            setTimeout(() => post({ type: 'close' }), 500)
          }}
          className="relative z-10"
        >
          <X size={24} />
        </IconButton>
        
        <h1 className="flex-1 truncate px-2 text-center text-lg font-bold text-accent-fg pointer-events-none">
          Support
        </h1>
        
        <div className="flex items-center relative z-10">
          <IconButton label="Search help articles" onClick={() => navigate('/embed/support/search')}>
            <Search size={24} />
          </IconButton>
          <IconButton label="Open chat" onClick={() => navigate('/embed/support/chat')} className="relative">
            <MessageCircle size={24} />
            {unread > 0 && (
              <span className="absolute top-1.5 right-1.5 flex min-w-5 items-center justify-center rounded-full bg-white px-1.5 text-xs font-bold text-accent shadow-sm">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </IconButton>
          <DebugButton onClick={props.onOpenDebug} />
        </div>
      </div>
    )
  }

  const title = props.variant === 'chat' ? 'Support' : props.title

  return (
    <div className={frame}>
      {/* navigate(-1), not a hardcoded route: it is the same gesture Android's
          hardware back button fires, and real routes are what make that work. */}
      <IconButton label="Back" onClick={() => navigate(-1)} className="relative z-10">
        <ArrowLeft size={24} />
      </IconButton>
      
      <h1 className="flex-1 truncate px-2 text-center text-lg font-bold text-accent-fg pointer-events-none">
        {title}
      </h1>
      
      <div className="flex items-center relative z-10">
        <DebugButton onClick={props.onOpenDebug} />
      </div>
    </div>
  )
}
