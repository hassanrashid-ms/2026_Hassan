import type { AgentConversationSummary, ConversationStatusValue } from '@support/types'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { cn } from '../../../lib/cn.ts'

export const STATUS_BADGE_VARIANT: Record<
  ConversationStatusValue,
  'default' | 'secondary' | 'success' | 'warning' | 'info' | 'destructive'
> = {
  new: 'info',
  bot_active: 'secondary',
  open: 'default',
  awaiting_player: 'warning',
  escalated: 'destructive',
  resolved: 'success',
  closed: 'secondary',
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return `${Math.round(diffHr / 24)}d ago`
}

export function ConversationRow({
  conversation,
  selected,
  onSelect,
  onClaim,
  claiming,
}: {
  conversation: AgentConversationSummary
  selected: boolean
  onSelect: () => void
  onClaim?: () => void
  claiming?: boolean
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Conversation with ${conversation.player.external_player_id}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect()
      }}
      className={cn(
        'group flex cursor-pointer flex-col gap-1 border-b border-slate-100 px-4 py-3 text-left transition-colors',
        selected ? 'bg-accent-soft' : 'hover:bg-accent-soft/50',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{conversation.player.external_player_id}</span>
        <Badge variant={STATUS_BADGE_VARIANT[conversation.status]}>{conversation.status}</Badge>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted">{conversation.last_message_preview ?? '(no messages)'}</span>
        <span className="shrink-0 text-xs text-muted">{relativeTime(conversation.last_message_at)}</span>
      </div>
      {onClaim && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-1 hidden self-start group-hover:inline-flex"
          disabled={claiming}
          onClick={(e) => {
            e.stopPropagation()
            onClaim()
          }}
        >
          Claim
        </Button>
      )}
    </div>
  )
}
