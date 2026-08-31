export type AdminConsoleBoot = {
  token: string;
  agentId: string;
  displayName: string;
};

/**
 * Built by the agent-console shell's "Switch to Admin Dashboard" action:
 * {origin}/dashboard/overview?agentId={agentId}&name={displayName}#t={agentToken}
 *
 * Mirrors consoleBoot.ts's convention (which does the reverse: admin ->
 * agent) — only the token goes in the fragment, everything else is fine in
 * the query string since none of it is a secret. No `workspace` param: an
 * admin token carries no workspace_id and admin-console's routes never need
 * one.
 */
export function readAdminConsoleBoot(location: { search: string; hash: string }): AdminConsoleBoot | null {
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));

  const token = fragment.get('t');
  const agentId = query.get('agentId');
  const displayName = query.get('name');
  if (!token || !agentId || !displayName) return null;

  return { token, agentId, displayName };
}
