const STORAGE_KEY = 'support_admin_session'

export type StoredAdminSession = {
  token: string
  agentId: string
  displayName: string
  isSuperAdmin: boolean
}

export function loadAdminSession(): StoredAdminSession | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredAdminSession
  } catch {
    return null
  }
}

export function saveAdminSession(session: StoredAdminSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function clearAdminSession(): void {
  localStorage.removeItem(STORAGE_KEY)
}
