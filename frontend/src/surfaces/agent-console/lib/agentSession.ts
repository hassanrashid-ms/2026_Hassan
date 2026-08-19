const STORAGE_KEY = 'support_agent_session'
const CONTEXT_RAIL_KEY = 'support_context_rail_open'

export type StoredAgentSession = {
  token: string
  agentId: string
  displayName: string
  workspaceSlug: string
}

export function loadAgentSession(): StoredAgentSession | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredAgentSession
  } catch {
    return null
  }
}

export function saveAgentSession(session: StoredAgentSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function clearAgentSession(): void {
  localStorage.removeItem(STORAGE_KEY)
}

// Persisted, not component state: a rail that re-collapses on every navigation
// is a rail agents stop opening.
export function loadContextRailOpen(): boolean {
  return localStorage.getItem(CONTEXT_RAIL_KEY) === 'true'
}

export function saveContextRailOpen(open: boolean): void {
  localStorage.setItem(CONTEXT_RAIL_KEY, String(open))
}
