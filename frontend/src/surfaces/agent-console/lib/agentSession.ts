const STORAGE_KEY = 'support_agent_session'

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
