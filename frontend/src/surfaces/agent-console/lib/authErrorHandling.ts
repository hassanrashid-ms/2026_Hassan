import { clearAgentSession } from './agentSession.ts'

/**
 * Fires from contexts outside the router — the global QueryCache/MutationCache
 * handler in main.tsx, and socket `connect_error` listeners registered before
 * mount — so a React Router `navigate()` isn't available. A hard reload also
 * guarantees no stale query cache or open socket survives an invalid session.
 */
export function handleSessionExpired(): void {
  clearAgentSession()
  if (window.location.pathname !== '/login') {
    window.location.assign('/login')
  }
}
