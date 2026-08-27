import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { loadAgentSession, type StoredAgentSession } from '../lib/agentSession.ts';

/**
 * Route-level RBAC gate — hiding a nav link is UX, this is the client-side
 * enforcement point that goes with it (the API is still the real one; see
 * CLAUDE.md's "Permission checks run at the API"). Without this, a role that
 * can't see a nav item could still open the page directly by URL and watch
 * it render broken/empty as its data calls 403.
 *
 * `allow` mirrors the same predicate (canBuildForms/isAdmin from
 * agentSession.ts) the nav item hidden behind this route already uses, so
 * the two can never drift apart into "nav hidden, page still opens" or
 * vice versa.
 */
export function RequireRole({
  allow,
  children,
}: {
  allow: (session: Pick<StoredAgentSession, 'role'> | null) => boolean;
  children: ReactNode;
}) {
  const session = loadAgentSession();
  if (!allow(session)) return <Navigate to="/inbox" replace />;
  return <>{children}</>;
}
