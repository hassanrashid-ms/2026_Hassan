import { Search } from 'lucide-react'
import { cn } from '@/surfaces/webview/lib/cn'

/**
 * Vite resolves this at build time. An empty record is the normal case — no game
 * has dropped a banner in yet — and the gradient below is a first-class design,
 * not a placeholder for a missing file.
 */
const heroModules = import.meta.glob('/src/assets/hero.*', { eager: true }) as Record<string, { default: string }>

/**
 * Split out from the component so both branches are testable without a build.
 * Takes the first entry in sorted key order so `hero.png` and `hero.webp` both
 * present resolves deterministically rather than to whatever the bundler
 * happened to enumerate first.
 */
export function resolveHeroAsset(modules: Record<string, { default: string }>): string | null {
  const [firstKey] = Object.keys(modules).sort()
  if (firstKey === undefined) return null
  return modules[firstKey]?.default ?? null
}

type SupportHeroProps = {
  gameName: string
  /**
   * Not used yet. Decision 5: a future server-driven, per-workspace banner should
   * be a prop that overrides the bundled asset, not a redesign of this component.
   */
  imageUrl?: string | undefined
  onSearchTap: () => void
}

export function SupportHero({ gameName, imageUrl, onSearchTap }: SupportHeroProps) {
  const asset = imageUrl ?? resolveHeroAsset(heroModules)

  return (
    <header
      className={cn(
        'relative flex h-[25dvh] shrink-0 flex-col justify-end overflow-hidden px-5 pb-4',
        // The gradient is the fallback and is drawn unconditionally: when an asset
        // exists it sits underneath as the scrim's base, so the overlaid text keeps
        // its contrast against a photograph nobody on this team has seen.
        'bg-linear-to-br from-accent to-accent-deep',
      )}
    >
      {asset !== null && (
        <>
          <img src={asset} alt="" aria-hidden className="absolute inset-0 size-full object-cover" />
          <div className="absolute inset-0 bg-linear-to-t from-black/65 via-black/20 to-transparent" />
        </>
      )}

      <div className="relative flex flex-col gap-3">
        <p className="text-2xl leading-tight font-extrabold text-white drop-shadow-sm">{gameName}</p>

        {/*
          A button that looks like an input, not an input.
          Focusing a real field here would raise the keyboard underneath a hero
          that is about to scroll away, and it keeps exactly one real search input
          in the entire app — on the screen built for it.
        */}
        <button
          type="button"
          onClick={onSearchTap}
          className="flex min-h-12 w-full items-center gap-3 rounded-card bg-bg/95 px-4 text-left transition-transform active:scale-[0.99] outline-none"
        >
          <Search className="size-5 shrink-0 text-muted" />
          <span className="truncate text-base text-muted">Search help</span>
        </button>
      </div>
    </header>
  )
}
