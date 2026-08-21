import type { AgentConversationSummary, ConversationPriorityValue, ConversationStatusValue } from '@support/types'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { cn } from '../../../lib/cn.ts'
import { tagBadgeClassName } from '../../../lib/tagBadge.ts'

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

export const PRIORITY_BADGE_VARIANT: Record<ConversationPriorityValue, 'default' | 'secondary' | 'warning' | 'destructive' | 'info' | 'success'> = {
  p1: 'destructive',
  p2: 'warning',
  p3: 'info',
  p4: 'success',
}

export function formatStatus(status: ConversationStatusValue): string {
  return status
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

// A queue row is a glance, not the full header — only the first few tags fit
// before they crowd out the message preview, and the rest are one click away
// in the conversation detail view.
const MAX_VISIBLE_TAGS = 3

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
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{conversation.player.external_player_id}</span>
        <span className="flex max-w-[70%] flex-none flex-wrap items-center justify-end gap-1.5 overflow-hidden">
          {/* No new data: confirm_phase already rides on the summary. A
              bot_active ticket sits in the unassigned queue, so without this a
              half-filled form reads as a stuck ticket. */}
          {conversation.confirm_phase === 'form' && (
            <span className="max-w-[110px] truncate text-xs text-muted">Answering questions</span>
          )}
          <Badge variant={PRIORITY_BADGE_VARIANT[conversation.priority]} className="max-w-16 truncate">
            {conversation.priority.toUpperCase()}
          </Badge>
          <Badge variant={STATUS_BADGE_VARIANT[conversation.status]} className="max-w-28 truncate">
            {formatStatus(conversation.status)}
          </Badge>
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{conversation.last_message_preview ?? '(no messages)'}</span>
        <span className="shrink-0 text-xs text-muted">{relativeTime(conversation.last_message_at)}</span>
      </div>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{conversation.assigned_agent_name ?? 'Unassigned'}</span>
        {conversation.tags.length > 0 && (
          <span className="flex max-w-[70%] flex-none flex-wrap items-center justify-end gap-1 overflow-hidden">
            {conversation.tags.slice(0, MAX_VISIBLE_TAGS).map((tag) => (
              <Badge key={tag.id} className={cn("max-w-20 truncate", tagBadgeClassName(tag.colorIndex))}>
                {tag.name}
              </Badge>
            ))}
            {conversation.tags.length > MAX_VISIBLE_TAGS && (
              <span className="text-xs text-muted shrink-0">+{conversation.tags.length - MAX_VISIBLE_TAGS}</span>
            )}
          </span>
        )}
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
