export type ConsoleBoot = {
  token: string
  workspaceId: string
  agentId: string
  displayName: string
}

/**
 * Built by the admin-console Overview page's "Open console" action (see
 * 2026-08-21-superadmin-workspace-console-access-design.md):
 * {origin}/inbox?workspace={workspaceId}&agentId={agentId}&name={displayName}#t={adminToken}
 *
 * Mirrors boot.ts's convention: only the token goes in the fragment (never
 * reaches a server request line), everything else is fine in the query string
 * since none of it is a secret.
 */
export function readConsoleBoot(location: { search: string; hash: string }): ConsoleBoot | null {
  const query = new URLSearchParams(location.search)
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''))

  const token = fragment.get('t')
  const workspaceId = query.get('workspace')
  const agentId = query.get('agentId')
  const displayName = query.get('name')
  if (!token || !workspaceId || !agentId || !displayName) return null

  return { token, workspaceId, agentId, displayName }
}
