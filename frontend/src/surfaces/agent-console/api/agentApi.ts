import type {
  AgentArticleDetail,
  AgentConversationsResponse,
  AgentMessagesResponse,
  AgentMessageView,
  AgentArticlesResponse,
  AgentConversationContextResponse,
  AgentConversationDetail,
  ArchiveIntentResponse,
  ArchiveSubintentResponse,
  AskResolvedResponse,
  ClaimResponse,
  ConversationPriority,
  CreateFormResponse,
  CreateIntentResponse,
  CreateSubintentResponse,
  EscalateResponse,
  FormDetail,
  FormField,
  FormsListResponse,
  IntentsResponse,
  MergeSubintentResponse,
  MoveSubintentResponse,
  RenameIntentResponse,
  RenameSubintentResponse,
  UnescalateResponse,
} from '@support/types'
import { apiCall } from '../../../lib/httpClient.ts'

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

/**
 * The header row for one conversation. Required, not an optimisation: an older
 * ticket is in neither the `unassigned` nor the `mine` list and never will be,
 * so opening one by URL yields no header data at all.
 */
export function fetchConversation(token: string, conversationId: string): Promise<AgentConversationDetail> {
  return apiCall(`/agent/conversations/${conversationId}`, token)
}

export function fetchConversationContext(
  token: string,
  conversationId: string,
): Promise<AgentConversationContextResponse> {
  return apiCall(`/agent/conversations/${conversationId}/context`, token)
}

export function fetchConversationMessages(token: string, conversationId: string): Promise<AgentMessagesResponse> {
  return apiCall(`/agent/conversations/${conversationId}/messages`, token)
}

export function sendAgentMessage(
  token: string,
  conversationId: string,
  body: string,
  visibility?: 'public' | 'internal',
): Promise<{ message: AgentMessageView }> {
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

export function fetchIntents(token: string): Promise<IntentsResponse> {
  return apiCall('/agent/intents', token)
}

export function createIntent(token: string, name: string): Promise<CreateIntentResponse> {
  return apiCall('/agent/intents', token, { method: 'POST', body: JSON.stringify({ name }) })
}

export function createSubintent(token: string, intentId: string, name: string): Promise<CreateSubintentResponse> {
  return apiCall(`/agent/intents/${intentId}/subintents`, token, { method: 'POST', body: JSON.stringify({ name }) })
}

export function renameIntent(token: string, id: string, name: string): Promise<RenameIntentResponse> {
  return apiCall(`/agent/intents/${id}`, token, { method: 'PATCH', body: JSON.stringify({ name }) })
}

export function archiveIntent(token: string, id: string): Promise<ArchiveIntentResponse> {
  return apiCall(`/agent/intents/${id}/archive`, token, { method: 'POST' })
}

export function renameSubintent(
  token: string,
  id: string,
  patch: { name?: string; defaultPriority?: ConversationPriority },
): Promise<RenameSubintentResponse> {
  return apiCall(`/agent/subintents/${id}`, token, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function archiveSubintent(token: string, id: string): Promise<ArchiveSubintentResponse> {
  return apiCall(`/agent/subintents/${id}/archive`, token, { method: 'POST' })
}

export function moveSubintent(token: string, id: string, intentId: string): Promise<MoveSubintentResponse> {
  return apiCall(`/agent/subintents/${id}/move`, token, { method: 'POST', body: JSON.stringify({ intentId }) })
}

export function mergeSubintent(token: string, id: string, intoId: string): Promise<MergeSubintentResponse> {
  return apiCall(`/agent/subintents/${id}/merge`, token, { method: 'POST', body: JSON.stringify({ intoId }) })
}

export function fetchArticles(token: string): Promise<AgentArticlesResponse> {
  return apiCall('/agent/articles', token)
}

export function fetchArticle(token: string, id: string): Promise<AgentArticleDetail> {
  return apiCall(`/agent/articles/${id}`, token)
}

export function createArticle(
  token: string,
  input: { title: string; body: string; keywords?: string[]; intent_id?: string },
): Promise<AgentArticleDetail> {
  return apiCall('/agent/articles', token, { method: 'POST', body: JSON.stringify(input) })
}

export function updateArticle(
  token: string,
  id: string,
  patch: { title?: string; body?: string; keywords?: string[]; intent_id?: string | null },
): Promise<AgentArticleDetail> {
  return apiCall(`/agent/articles/${id}`, token, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function publishArticle(token: string, id: string): Promise<AgentArticleDetail> {
  return apiCall(`/agent/articles/${id}/publish`, token, { method: 'POST' })
}

export function archiveArticle(token: string, id: string): Promise<AgentArticleDetail> {
  return apiCall(`/agent/articles/${id}/archive`, token, { method: 'POST' })
}

export function fetchForms(token: string): Promise<FormsListResponse> {
  return apiCall('/agent/forms', token)
}

export function fetchForm(token: string, id: string): Promise<FormDetail> {
  return apiCall(`/agent/forms/${id}`, token)
}

export function createForm(token: string, name: string): Promise<CreateFormResponse> {
  return apiCall('/agent/forms', token, { method: 'POST', body: JSON.stringify({ name }) })
}

export function updateForm(
  token: string,
  id: string,
  patch: { name?: string; fields?: FormField[] },
): Promise<FormDetail> {
  return apiCall(`/agent/forms/${id}`, token, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function publishForm(token: string, id: string): Promise<FormDetail> {
  return apiCall(`/agent/forms/${id}/publish`, token, { method: 'POST' })
}

export function archiveForm(token: string, id: string): Promise<FormDetail> {
  return apiCall(`/agent/forms/${id}/archive`, token, { method: 'POST' })
}

export function setFormSubintents(token: string, id: string, subintentIds: string[]): Promise<FormDetail> {
  return apiCall(`/agent/forms/${id}/subintents`, token, {
    method: 'PATCH',
    body: JSON.stringify({ subintentIds }),
  })
}

export function askResolved(token: string, conversationId: string): Promise<AskResolvedResponse> {
  return apiCall(`/agent/conversations/${conversationId}/ask-resolved`, token, { method: 'POST' })
}

export function escalateConversation(token: string, conversationId: string): Promise<EscalateResponse> {
  return apiCall(`/agent/conversations/${conversationId}/escalate`, token, { method: 'POST' })
}

export function unescalateConversation(token: string, conversationId: string): Promise<UnescalateResponse> {
  return apiCall(`/agent/conversations/${conversationId}/unescalate`, token, { method: 'POST' })
}
