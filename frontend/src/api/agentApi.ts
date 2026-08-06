import type { AgentConversationsResponse, AgentMessagesResponse, ClaimResponse } from '@support/types'
import { apiCall } from './httpClient.ts'

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'

export type DevAgentOption = { id: string; email: string; display_name: string }
export type DevLoginResponse = {
  token: string
  agent: { id: string; display_name: string }
  workspace: { id: string; slug: string }
}

export async function fetchDevAgents(): Promise<{ agents: DevAgentOption[] }> {
  const res = await fetch(`${BASE}/agent/auth/dev-agents`)
  if (!res.ok) throw new Error(`Request failed with ${res.status}`)
  return (await res.json()) as { agents: DevAgentOption[] }
}

export async function devLogin(agentId: string): Promise<DevLoginResponse> {
  const res = await fetch(`${BASE}/agent/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId }),
  })
  if (!res.ok) throw new Error(`Request failed with ${res.status}`)
  return (await res.json()) as DevLoginResponse
}

export function fetchInbox(token: string, status: 'unassigned' | 'mine'): Promise<AgentConversationsResponse> {
  return apiCall(`/agent/conversations?status=${status}`, token)
}

export function claimConversation(token: string, conversationId: string): Promise<ClaimResponse> {
  return apiCall(`/agent/conversations/${conversationId}/claim`, token, { method: 'POST' })
}

export function fetchConversationMessages(token: string, conversationId: string): Promise<AgentMessagesResponse> {
  return apiCall(`/agent/conversations/${conversationId}/messages`, token)
}

export function sendAgentMessage(
  token: string,
  conversationId: string,
  body: string,
  visibility?: 'public' | 'internal',
): Promise<{ message: unknown }> {
  return apiCall(`/agent/messages`, token, {
    method: 'POST',
    body: JSON.stringify({ conversation_id: conversationId, body, visibility }),
  })
}

export function markAgentMessagesRead(token: string, conversationId: string, upToSeq: number): Promise<{ ok: true }> {
  return apiCall(`/agent/messages/read`, token, {
    method: 'POST',
    body: JSON.stringify({ conversation_id: conversationId, up_to_seq: upToSeq }),
  })
}
