import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DashboardLayout } from '@support/types'
import { fetchLayout, saveLayout } from '../../api/analyticsApi.ts'
import { loadAgentSession } from '../../lib/agentSession.ts'

const SAVE_DEBOUNCE_MS = 500

export function useTileLayout() {
  const session = loadAgentSession()
  const query = useQuery({
    queryKey: ['analytics', 'layout'],
    queryFn: () => fetchLayout(session!.token),
    enabled: session !== null,
  })

  const [layout, setLayout] = useState<DashboardLayout | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (query.data && layout === null) setLayout(query.data.layout)
  }, [query.data, layout])

  const updateLayout = useCallback(
    (next: DashboardLayout) => {
      setLayout(next)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        if (!session) return
        setIsSaving(true)
        saveLayout(session.token, next).finally(() => setIsSaving(false))
      }, SAVE_DEBOUNCE_MS)
    },
    [session],
  )

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  return { layout, updateLayout, isSaving, isLoading: query.isLoading, isError: query.isError }
}
