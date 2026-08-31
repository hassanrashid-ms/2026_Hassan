import { apiCall } from '../../../lib/httpClient.ts';
import type {
  ArchiveDeclaredFieldResponse,
  CreateDeclaredFieldResponse,
  DeactivateDeclaredFieldResponse,
  DeclaredFieldsResponse,
  DeclaredFieldType,
  ReactivateDeclaredFieldResponse,
  UpdateDeclaredFieldResponse,
} from '@support/types';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

/*
 * Dev login lives here rather than duplicated per-surface: routes/Login.tsx
 * (the composition root, not a surface) is the only caller now that it's the
 * single picker for both consoles — see
 * docs/decisions/2026-08-04-agent-auth-google-oauth.md for why this dev
 * picker exists at all.
 */
export type DevAgentOption = { id: string; email: string; display_name: string };
export type DevLoginResponse = {
  token: string;
  agent: { id: string; display_name: string };
  // Always null here in practice — this surface only signs in agents who pass
  // the is_admin check below, and an admin's token carries no workspace_id
  // (see 2026-08-21-superadmin-workspace-console-access-design.md).
  workspace: { id: string; slug: string } | null;
};

// See httpClient.ts's NGROK_SKIP_WARNING_HEADER comment — these two calls run
// before a token exists, so they can't go through apiCall, but need the same
// bypass: without it, an ngrok free-tier tunnel serves an HTML interstitial
// (still a 200) that fails .json() with a SyntaxError.
const NGROK_SKIP_WARNING_HEADER = { 'ngrok-skip-browser-warning': 'true' };

export async function fetchDevAgents(): Promise<{ agents: DevAgentOption[] }> {
  const res = await fetch(`${BASE}/agent/auth/dev-agents`, { headers: NGROK_SKIP_WARNING_HEADER });
  if (!res.ok) throw new Error(`Request failed with ${res.status}`);
  return (await res.json()) as { agents: DevAgentOption[] };
}

export async function devLogin(agentId: string): Promise<DevLoginResponse> {
  const res = await fetch(`${BASE}/agent/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...NGROK_SKIP_WARNING_HEADER },
    body: JSON.stringify({ agent_id: agentId }),
  });
  if (!res.ok) throw new Error(`Request failed with ${res.status}`);
  return (await res.json()) as DevLoginResponse;
}

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  member_count: number;
  created_at: string;
};

export function fetchWorkspaces(token: string): Promise<{ workspaces: WorkspaceSummary[] }> {
  return apiCall('/admin/workspaces', token);
}

export function createWorkspace(
  token: string,
  input: { name: string; slug: string },
): Promise<WorkspaceSummary> {
  return apiCall('/admin/workspaces', token, { method: 'POST', body: JSON.stringify(input) });
}

export function renameWorkspace(
  token: string,
  id: string,
  name: string,
): Promise<WorkspaceSummary> {
  return apiCall(`/admin/workspaces/${id}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export type MemberSummary = {
  agent_id: string;
  email: string;
  display_name: string;
  status: string;
  role: 'agent' | 'team_lead';
};

export function fetchMembers(
  token: string,
  workspaceId: string,
): Promise<{ members: MemberSummary[] }> {
  return apiCall(`/admin/workspaces/${workspaceId}/members`, token);
}

export function addMember(
  token: string,
  workspaceId: string,
  input: { email: string; role: 'agent' | 'team_lead' },
): Promise<MemberSummary> {
  return apiCall(`/admin/workspaces/${workspaceId}/members`, token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
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
  });
}

export type SecretMetadata = { created_at: string; expires_at: string | null };

export function fetchSecrets(
  token: string,
  workspaceId: string,
): Promise<{ secrets: SecretMetadata[] }> {
  return apiCall(`/admin/workspaces/${workspaceId}/secret`, token);
}

export function rotateSecret(
  token: string,
  workspaceId: string,
): Promise<{ secret: string; created_at: string }> {
  return apiCall(`/admin/workspaces/${workspaceId}/secret/rotate`, token, { method: 'POST' });
}

export type AgentSummary = {
  id: string;
  email: string;
  display_name: string;
  status: string;
  is_admin: boolean;
  is_super_admin: boolean;
};

export function fetchAgents(token: string, query?: string): Promise<{ agents: AgentSummary[] }> {
  const qs = query ? `?q=${encodeURIComponent(query)}` : '';
  return apiCall(`/admin/agents${qs}`, token);
}

export function setAdminFlag(token: string, id: string, isAdmin: boolean): Promise<AgentSummary> {
  return apiCall(`/admin/agents/${id}/admin`, token, {
    method: 'PATCH',
    body: JSON.stringify({ is_admin: isAdmin }),
  });
}

export function setSuperAdminFlag(
  token: string,
  id: string,
  isSuperAdmin: boolean,
): Promise<AgentSummary> {
  return apiCall(`/admin/agents/${id}/super-admin`, token, {
    method: 'PATCH',
    body: JSON.stringify({ is_super_admin: isSuperAdmin }),
  });
}

export function fetchDeclaredFields(
  token: string,
  workspaceId: string,
): Promise<DeclaredFieldsResponse> {
  return apiCall(`/admin/workspaces/${workspaceId}/declared-fields`, token);
}

export function createDeclaredField(
  token: string,
  workspaceId: string,
  input: { key: string; label: string; type: DeclaredFieldType },
): Promise<CreateDeclaredFieldResponse> {
  return apiCall(`/admin/workspaces/${workspaceId}/declared-fields`, token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateDeclaredField(
  token: string,
  workspaceId: string,
  id: string,
  patch: { label?: string; type?: DeclaredFieldType },
): Promise<UpdateDeclaredFieldResponse> {
  return apiCall(`/admin/workspaces/${workspaceId}/declared-fields/${id}`, token, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deactivateDeclaredField(
  token: string,
  workspaceId: string,
  id: string,
): Promise<DeactivateDeclaredFieldResponse> {
  return apiCall(`/admin/workspaces/${workspaceId}/declared-fields/${id}/deactivate`, token, {
    method: 'POST',
  });
}

export function reactivateDeclaredField(
  token: string,
  workspaceId: string,
  id: string,
): Promise<ReactivateDeclaredFieldResponse> {
  return apiCall(`/admin/workspaces/${workspaceId}/declared-fields/${id}/reactivate`, token, {
    method: 'POST',
  });
}

export function archiveDeclaredField(
  token: string,
  workspaceId: string,
  id: string,
): Promise<ArchiveDeclaredFieldResponse> {
  return apiCall(`/admin/workspaces/${workspaceId}/declared-fields/${id}/archive`, token, {
    method: 'POST',
  });
}
