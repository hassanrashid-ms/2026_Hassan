import { clearAdminSession } from './adminSession.ts'

/**
 * Mirrors agent-console's authErrorHandling.ts. Fires from contexts outside the
 * router (the global QueryCache/MutationCache handler in main.tsx), so a React
 * Router `navigate()` isn't available — a hard reload also guarantees no stale
 * query cache survives an invalid session.
 */
export function handleAdminSessionExpired(): void {
  clearAdminSession()
  if (window.location.pathname !== '/dashboard/login') {
    window.location.assign('/dashboard/login')
  }
}
