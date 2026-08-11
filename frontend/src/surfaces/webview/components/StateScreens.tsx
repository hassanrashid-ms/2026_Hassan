import type { ReactNode } from 'react'
import { MessageCircle, PlugZap, RotateCw, SearchX } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Skeleton } from '@/surfaces/webview/components/ui/skeleton'
import { SupportButton } from '@/surfaces/webview/components/SupportButton'
import { cn } from '@/surfaces/webview/lib/cn'

/**
 * Every screen renders one of these rather than a blank region. "No dead ends" is
 * a repo rule, so each of them either offers an action or explains why there
 * isn't one.
 */

function CentredMessage({ icon, title, body, children }: { icon: ReactNode; title: string; body: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-accent-soft text-accent">{icon}</div>
      <h1 className="text-xl font-bold text-text">{title}</h1>
      <p className="max-w-[22rem] text-base leading-relaxed text-muted">{body}</p>
      {children}
    </div>
  )
}

/**
 * No token at all. Deliberately renders without a top bar: there is no session to
 * close, so a ✕ would post a bridge message the game may not be listening for and
 * a back arrow would have nowhere to go.
 */
export function NoSessionScreen({ message }: { message: string }) {
  return <CentredMessage icon={<PlugZap className="size-8" />} title="Open support from the game" body={message} />
}

/**
 * Bootstrap exhausted its 15 attempts. New behaviour: today the poll simply stops
 * and leaves the player on whatever was on screen with no way back. Chat is still
 * offered here — "no dead ends" outranks having complete data, and the token we
 * need to open a conversation is already in hand.
 */
export function BootstrapFailedScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <CentredMessage
      icon={<PlugZap className="size-8" />}
      title="Could not load support"
      body={message}
    >
      <div className="mt-2 flex flex-col items-stretch gap-3">
        <SupportButton onClick={onRetry}>
          <RotateCw className="size-5" />
          Try again
        </SupportButton>
        <Link to="/embed/support/chat" className="contents">
          <SupportButton variant="soft" className="w-full">
            <MessageCircle className="size-5" />
            Talk to us anyway
          </SupportButton>
        </Link>
      </div>
    </CentredMessage>
  )
}

/** Per-screen empty copy. "No articles yet" on home, "No results for …" on search. */
export function EmptyState({ title, body, icon }: { title: string; body?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-surface text-muted">
        {icon ?? <SearchX className="size-7" />}
      </div>
      <p className="text-lg font-semibold text-text">{title}</p>
      {body !== undefined && <p className="text-base text-muted">{body}</p>}
    </div>
  )
}

/**
 * Skeleton in the shape of the content, not a spinner: a spinner tells the player
 * nothing about what is arriving, and the layout jumps when it resolves.
 */
export function ArticleListSkeleton({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3', className)} aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col gap-3 rounded-card bg-surface p-5">
          <Skeleton className="h-5 w-3/4 bg-muted/15" />
          <Skeleton className="h-4 w-1/2 bg-muted/15" />
        </div>
      ))}
    </div>
  )
}
