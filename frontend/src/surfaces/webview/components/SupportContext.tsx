import { createContext, useContext } from 'react'
import type { BootstrapResponse } from '@support/types'
import type { SurfaceBoot } from '@/lib/boot'

export type SupportContextValue = {
  /** null only while the very first mount effect has not run yet. */
  boot: SurfaceBoot | null
  /** null until bootstrap lands. Screens render their fallback copy, never a blank. */
  data: BootstrapResponse | null
  /** Set only by the terminal failures: no token at all, or the poll exhausted. */
  error: string | null
  /** Restarts the bootstrap fetch and the poll. Wired to the retry button. */
  retry: () => void
}

const SupportContext = createContext<SupportContextValue | null>(null)

export const SupportContextProvider = SupportContext.Provider

export function useSupport(): SupportContextValue {
  const value = useContext(SupportContext)
  if (value === null) throw new Error('useSupport must be used inside WebviewShell.')
  return value
}

/**
 * Decision 2: the game's name comes from BootstrapResponse.workspace.name, with a
 * generic fallback. The fallback string *is* the loading placeholder — a skeleton
 * where a title will be is more visually disruptive than a word that is already
 * true, and the title never reflows to a different length twice.
 */
export function useGameName(): string {
  const { data } = useSupport()
  return data?.workspace.name || 'Game Support'
}
