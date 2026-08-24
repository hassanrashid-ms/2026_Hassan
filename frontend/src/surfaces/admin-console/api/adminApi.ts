import { apiCall } from '../../../lib/httpClient.ts'

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'

/*
 * Dev login is duplicated from agent-console/api/agentApi.ts rather than
 * imported — surfaces never cross-import (see CLAUDE.md's Folder structure
 * rule), and this surface's session shape (isSuperAdmin, no workspaceSlug) is
 * different enough that sharing the response handling wouldn't save much.
 */
export type DevAgentOption = { id: string; email: string; display_name: string }
export type DevLoginResponse = {
  token: string
  agent: { id: string; display_name: string }
  // Always null here in practice — this surface only signs in agents who pass
  // the is_admin check below, and an admin's token carries no workspace_id
  // (see 2026-08-21-superadmin-workspace-console-access-design.md).
  workspace: { id: string; slug: string } | null
}

// See httpClient.ts's NGROK_SKIP_WARNING_HEADER comment — these two calls run
// before a token exists, so they can't go through apiCall, but need the same
// bypass: without it, an ngrok free-tier tunnel serves an HTML interstitial
// (still a 200) that fails .json() with a SyntaxError.
const NGROK_SKIP_WARNING_HEADER = { 'ngrok-skip-browser-warning': 'true' }

export async function fetchDevAgents(): Promise<{ agents: DevAgentOption[] }> {
  const res = await fetch(`${BASE}/agent/auth/dev-agents`, { headers: NGROK_SKIP_WARNING_HEADER })
  if (!res.ok) throw new Error(`Request failed with ${res.status}`)
  return (await res.json()) as { agents: DevAgentOption[] }
}

export async function devLogin(agentId: string): Promise<DevLoginResponse> {
  const res = await fetch(`${BASE}/agent/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...NGROK_SKIP_WARNING_HEADER },
    body: JSON.stringify({ agent_id: agentId }),
  })
  if (!res.ok) throw new Error(`Request failed with ${res.status}`)
  return (await res.json()) as DevLoginResponse
}

export type WorkspaceSummary = {
  id: string
  name: string
  slug: string
  member_count: number
  created_at: string
}

export function fetchWorkspaces(token: string): Promise<{ workspaces: WorkspaceSummary[] }> {
  return apiCall('/admin/workspaces', token)
}

export function createWorkspace(token: string, input: { name: string; slug: string }): Promise<WorkspaceSummary> {
  return apiCall('/admin/workspaces', token, { method: 'POST', body: JSON.stringify(input) })
}

export function renameWorkspace(token: string, id: string, name: string): Promise<WorkspaceSummary> {
  return apiCall(`/admin/workspaces/${id}`, token, { method: 'PATCH', body: JSON.stringify({ name }) })
}

export type MemberSummary = {
  agent_id: string
  email: string
  display_name: string
  status: string
  role: 'agent' | 'team_lead'
}

export function fetchMembers(token: string, workspaceId: string): Promise<{ members: MemberSummary[] }> {
  return apiCall(`/admin/workspaces/${workspaceId}/members`, token)
}

export function addMember(
  token: string,
  workspaceId: string,
  input: { email: string; role: 'agent' | 'team_lead' },
): Promise<MemberSummary> {
  return apiCall(`/admin/workspaces/${workspaceId}/members`, token, { method: 'POST', body: JSON.stringify(input) })
}

export function updateMember(
  token: string,
  workspaceId: string,
  agentId: string,
  patch: { role?: 'agent' | 'team_lead'; remove?: boolean },
): Promise<MemberSummary | { removed: true }> {
  return apiCall(`/admin/workspaces/${workspaceId}/members/${agentId}`, token, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export type SecretMetadata = { created_at: string; expires_at: string | null }

export function fetchSecrets(token: string, workspaceId: string): Promise<{ secrets: SecretMetadata[] }> {
  return apiCall(`/admin/workspaces/${workspaceId}/secret`, token)
}

export function rotateSecret(token: string, workspaceId: string): Promise<{ secret: string; created_at: string }> {
  return apiCall(`/admin/workspaces/${workspaceId}/secret/rotate`, token, { method: 'POST' })
}

export type AgentSummary = {
  id: string
  email: string
  display_name: string
  status: string
  is_admin: boolean
  is_super_admin: boolean
}

export function fetchAgents(token: string, query?: string): Promise<{ agents: AgentSummary[] }> {
  const qs = query ? `?q=${encodeURIComponent(query)}` : ''
  return apiCall(`/admin/agents${qs}`, token)
}

export function setAdminFlag(token: string, id: string, isAdmin: boolean): Promise<AgentSummary> {
  return apiCall(`/admin/agents/${id}/admin`, token, { method: 'PATCH', body: JSON.stringify({ is_admin: isAdmin }) })
}

export function setSuperAdminFlag(token: string, id: string, isSuperAdmin: boolean): Promise<AgentSummary> {
  return apiCall(`/admin/agents/${id}/super-admin`, token, {
    method: 'PATCH',
    body: JSON.stringify({ is_super_admin: isSuperAdmin }),
  })
}
