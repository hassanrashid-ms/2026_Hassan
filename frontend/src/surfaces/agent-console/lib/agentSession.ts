const STORAGE_KEY = 'support_agent_session'
const CONTEXT_RAIL_KEY = 'support_context_rail_open'

/**
 * Mirrors `WorkspaceRole` in `backend/src/shared/middleware/requireWorkspaceRole.ts`.
 * Not sourced from `@support/types` — that package is the SDK↔server wire
 * contract, and role isn't part of it.
 */
export type AgentRole = 'agent' | 'team_lead' | 'admin'

export type StoredAgentSession = {
  token: string
  agentId: string
  displayName: string
  workspaceSlug: string
  /**
   * Optional because the current dev-login response (`POST /agent/auth/dev-login`)
   * doesn't return a role yet — real role plumbing through Google OAuth is a
   * separate backend slice. Every role gate below treats a missing role as
   * "unknown, not unauthorized": it shows the control rather than hiding it,
   * since hiding is UX only and the API enforces the real check regardless
   * (see requireWorkspaceRole/requireAdminRole). Once login starts returning a
   * role, gates tighten automatically with no UI change needed.
   */
  role?: AgentRole
}

export function canBuildForms(session: Pick<StoredAgentSession, 'role'> | null): boolean {
  return session?.role === undefined || session.role === 'team_lead' || session.role === 'admin'
}

export function isAdmin(session: Pick<StoredAgentSession, 'role'> | null): boolean {
  return session?.role === undefined || session.role === 'admin'
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
