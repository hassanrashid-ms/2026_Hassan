import { Check, ChevronRight } from 'lucide-react'
import { Badge } from '@/surfaces/webview/components/ui/badge'
import { cn } from '@/surfaces/webview/lib/cn'

type ArticleCardProps = {
  title: string
  keywords: readonly string[]
  read: boolean
  onOpen: () => void
}

/** Shown on home and on search results — the same card, so a result never reads
 *  as a different kind of thing from the list it came out of. */
export function ArticleCard({ title, keywords, read, onOpen }: ArticleCardProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full items-center gap-3 rounded-card bg-surface p-5 text-left',
        'transition-transform active:scale-[0.99] outline-none',
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="flex items-start gap-2">
          <span className={cn('flex-1 text-lg leading-snug font-semibold', read ? 'text-muted' : 'text-text')}>
            {title}
          </span>
          {read && (
            <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted">
              <Check className="size-3.5" />
              Read
            </span>
          )}
        </span>

        {keywords.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {keywords.map((keyword) => (
              <Badge key={keyword} variant="soft">
                {keyword}
              </Badge>
            ))}
          </span>
        )}
      </span>
      <ChevronRight className="size-5 shrink-0 text-muted/50" />
    </button>
  )
}
