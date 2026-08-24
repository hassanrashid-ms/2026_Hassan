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
  AttachTagResponse,
  BotConfigView,
  ChangeLogHistoryResponse,
  ClaimResponse,
  TakeOverResponse,
  ConversationPriority,
  CreateFormResponse,
  CreateIntentResponse,
  CreateSubintentResponse,
  CreateTagResponse,
  DetachTagResponse,
  EscalateResponse,
  FormDetail,
  FormField,
  FormsListResponse,
  IntentsResponse,
  MergeSubintentResponse,
  MoveSubintentResponse,
  RenameIntentResponse,
  RenameSubintentResponse,
  RollbackBotConfigBodyValue,
  SaveBotConfigBodyValue,
  TagView,
  UnescalateResponse,
} from '@support/types';
import { apiCall } from '../../../lib/httpClient.ts';
import { loadAgentSession } from '../lib/agentSession.ts';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

export type DevAgentOption = { id: string; email: string; display_name: string };
export type DevLoginResponse = {
  token: string;
  agent: { id: string; display_name: string };
  // null for a global admin — their token carries no workspace_id (see
  // 2026-08-21-superadmin-workspace-console-access-design.md); they pick a
  // workspace per console session from the admin-console Overview page instead.
  workspace: { id: string; slug: string } | null;
};

/**
 * Every /agent/* call goes through this instead of apiCall directly, so
 * X-Workspace-Id is attached without threading workspaceId through every
 * function signature in this file. See httpClient.ts's apiCall docstring for
 * why the header is harmless to send unconditionally.
 */
function call<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  return apiCall(path, token, init, loadAgentSession()?.workspaceId);
}

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

export type ConversationListFilter =
  'unassigned' | 'mine' | 'agentAssigned' | 'botHandling' | 'escalated';

export type TicketsQueryFilters = {
  q?: string;
  priority?: string[];
  labelIds?: string[];
  subintentIds?: string[];
  assigneeIds?: string[];
  olderThanHours?: number;
};

function buildTicketsQuery(status: ConversationListFilter, filters?: TicketsQueryFilters): string {
  const params = new URLSearchParams({ status });
  if (filters?.q) params.set('q', filters.q);
  if (filters?.priority?.length) filters.priority.forEach((p) => params.append('priority', p));
  if (filters?.labelIds?.length) filters.labelIds.forEach((l) => params.append('labelIds', l));
  if (filters?.subintentIds?.length)
    filters.subintentIds.forEach((s) => params.append('subintentIds', s));
  if (filters?.assigneeIds?.length)
    filters.assigneeIds.forEach((a) => params.append('assigneeIds', a));
  if (filters?.olderThanHours) params.set('olderThanHours', String(filters.olderThanHours));
  return params.toString();
}

export function fetchInbox(
  token: string,
  status: ConversationListFilter,
  filters?: TicketsQueryFilters,
): Promise<AgentConversationsResponse> {
  return call(`/agent/conversations?${buildTicketsQuery(status, filters)}`, token);
}

export function takeOverConversation(
  token: string,
  conversationId: string,
): Promise<TakeOverResponse> {
  return call(`/agent/conversations/${conversationId}/take-over`, token, { method: 'POST' });
}

export function claimConversation(token: string, conversationId: string): Promise<ClaimResponse> {
  return call(`/agent/conversations/${conversationId}/claim`, token, { method: 'POST' });
}

export function reassignConversation(
  token: string,
  conversationId: string,
  agentId: string,
): Promise<{ reassigned: boolean }> {
  return call(`/agent/conversations/${conversationId}/assign`, token, {
    method: 'PATCH',
    body: JSON.stringify({ agentId }),
  });
}

export function reclassifyConversation(
  token: string,
  conversationId: string,
  subintentId: string,
): Promise<{ reclassified: boolean }> {
  return call(`/agent/conversations/${conversationId}/subintent`, token, {
    method: 'PATCH',
    body: JSON.stringify({ subintentId }),
  });
}

/**
 * The header row for one conversation. Required, not an optimisation: an older
 * ticket is in neither the `unassigned` nor the `mine` list and never will be,
 * so opening one by URL yields no header data at all.
 */
export function fetchConversation(
  token: string,
  conversationId: string,
): Promise<AgentConversationDetail> {
  return call(`/agent/conversations/${conversationId}`, token);
}

export function fetchConversationContext(
  token: string,
  conversationId: string,
): Promise<AgentConversationContextResponse> {
  return call(`/agent/conversations/${conversationId}/context`, token);
}

export function fetchConversationMessages(
  token: string,
  conversationId: string,
): Promise<AgentMessagesResponse> {
  return call(`/agent/conversations/${conversationId}/messages`, token);
}

export function sendAgentMessage(
  token: string,
  conversationId: string,
  body: string,
  visibility?: 'public' | 'internal',
): Promise<{ message: AgentMessageView }> {
  return call(`/agent/messages`, token, {
    method: 'POST',
    body: JSON.stringify({ conversation_id: conversationId, body, visibility }),
  });
}

export function markAgentMessagesRead(
  token: string,
  conversationId: string,
  upToSeq: number,
): Promise<{ ok: true }> {
  return call(`/agent/messages/read`, token, {
    method: 'POST',
    body: JSON.stringify({ conversation_id: conversationId, up_to_seq: upToSeq }),
  });
}

/**
 * `/agent/workload` is a local frontend-side contract, not sourced from
 * `@support/types`, since that package is the SDK↔server wire contract.
 */
export type AgentWorkloadEntry = {
  agentId: string;
  agentName: string;
  openCount: number;
  resolved7d: number;
};

export type AgentWorkloadResponse = {
  agents: AgentWorkloadEntry[];
};

export function fetchWorkload(token: string): Promise<AgentWorkloadResponse> {
  return call('/agent/workload', token);
}

export function fetchIntents(token: string): Promise<IntentsResponse> {
  return call('/agent/intents', token);
}

export type WorkspaceAgentOption = { id: string; display_name: string };

export function fetchWorkspaceAgents(token: string): Promise<{ agents: WorkspaceAgentOption[] }> {
  return call('/agent/agents', token);
}

export function fetchTags(token: string, query?: string): Promise<TagView[]> {
  const qs = query ? `?query=${encodeURIComponent(query)}` : '';
  return call(`/agent/tags${qs}`, token);
}

export function createTag(token: string, name: string): Promise<CreateTagResponse> {
  return call('/agent/tags', token, { method: 'POST', body: JSON.stringify({ name }) });
}

export function attachTag(
  token: string,
  conversationId: string,
  tagId: string,
): Promise<AttachTagResponse> {
  return call(`/agent/conversations/${conversationId}/tags`, token, {
    method: 'POST',
    body: JSON.stringify({ tagId }),
  });
}

export function detachTag(
  token: string,
  conversationId: string,
  tagId: string,
): Promise<DetachTagResponse> {
  return call(`/agent/conversations/${conversationId}/tags/${tagId}`, token, { method: 'DELETE' });
}

export function createIntent(token: string, name: string): Promise<CreateIntentResponse> {
  return call('/agent/intents', token, { method: 'POST', body: JSON.stringify({ name }) });
}

export function createSubintent(
  token: string,
  intentId: string,
  name: string,
): Promise<CreateSubintentResponse> {
  return call(`/agent/intents/${intentId}/subintents`, token, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function renameIntent(
  token: string,
  id: string,
  name: string,
): Promise<RenameIntentResponse> {
  return call(`/agent/intents/${id}`, token, { method: 'PATCH', body: JSON.stringify({ name }) });
}

export function archiveIntent(token: string, id: string): Promise<ArchiveIntentResponse> {
  return call(`/agent/intents/${id}/archive`, token, { method: 'POST' });
}

export function renameSubintent(
  token: string,
  id: string,
  patch: { name?: string; defaultPriority?: ConversationPriority },
): Promise<RenameSubintentResponse> {
  return call(`/agent/subintents/${id}`, token, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function archiveSubintent(token: string, id: string): Promise<ArchiveSubintentResponse> {
  return call(`/agent/subintents/${id}/archive`, token, { method: 'POST' });
}

export function moveSubintent(
  token: string,
  id: string,
  intentId: string,
): Promise<MoveSubintentResponse> {
  return call(`/agent/subintents/${id}/move`, token, {
    method: 'POST',
    body: JSON.stringify({ intentId }),
  });
}

export function mergeSubintent(
  token: string,
  id: string,
  intoId: string,
): Promise<MergeSubintentResponse> {
  return call(`/agent/subintents/${id}/merge`, token, {
    method: 'POST',
    body: JSON.stringify({ intoId }),
  });
}

export function fetchArticles(token: string): Promise<AgentArticlesResponse> {
  return call('/agent/articles', token);
}

export function fetchArticle(token: string, id: string): Promise<AgentArticleDetail> {
  return call(`/agent/articles/${id}`, token);
}

export function createArticle(
  token: string,
  input: { title: string; body: string; keywords?: string[]; intent_id?: string },
): Promise<AgentArticleDetail> {
  return call('/agent/articles', token, { method: 'POST', body: JSON.stringify(input) });
}

export function generateKeywords(
  token: string,
  input: { title: string; body: string },
): Promise<{ keywords: string[] }> {
  return call('/agent/articles/generate-keywords', token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateArticle(
  token: string,
  id: string,
  patch: { title?: string; body?: string; keywords?: string[]; intent_id?: string | null },
): Promise<AgentArticleDetail> {
  return call(`/agent/articles/${id}`, token, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function publishArticle(token: string, id: string): Promise<AgentArticleDetail> {
  return call(`/agent/articles/${id}/publish`, token, { method: 'POST' });
}

export function archiveArticle(token: string, id: string): Promise<AgentArticleDetail> {
  return call(`/agent/articles/${id}/archive`, token, { method: 'POST' });
}

export function fetchForms(token: string): Promise<FormsListResponse> {
  return call('/agent/forms', token);
}

export function fetchForm(token: string, id: string): Promise<FormDetail> {
  return call(`/agent/forms/${id}`, token);
}

export function createForm(token: string, name: string): Promise<CreateFormResponse> {
  return call('/agent/forms', token, { method: 'POST', body: JSON.stringify({ name }) });
}

export function updateForm(
  token: string,
  id: string,
  patch: { name?: string; fields?: FormField[] },
): Promise<FormDetail> {
  return call(`/agent/forms/${id}`, token, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function publishForm(token: string, id: string): Promise<FormDetail> {
  return call(`/agent/forms/${id}/publish`, token, { method: 'POST' });
}

export function archiveForm(token: string, id: string): Promise<FormDetail> {
  return call(`/agent/forms/${id}/archive`, token, { method: 'POST' });
}

export function setFormSubintents(
  token: string,
  id: string,
  subintentIds: string[],
): Promise<FormDetail> {
  return call(`/agent/forms/${id}/subintents`, token, {
    method: 'PATCH',
    body: JSON.stringify({ subintentIds }),
  });
}

export function askResolved(token: string, conversationId: string): Promise<AskResolvedResponse> {
  return call(`/agent/conversations/${conversationId}/ask-resolved`, token, { method: 'POST' });
}

export function escalateConversation(
  token: string,
  conversationId: string,
): Promise<EscalateResponse> {
  return call(`/agent/conversations/${conversationId}/escalate`, token, { method: 'POST' });
}

export function unescalateConversation(
  token: string,
  conversationId: string,
): Promise<UnescalateResponse> {
  return call(`/agent/conversations/${conversationId}/unescalate`, token, { method: 'POST' });
}

export function fetchBotConfig(token: string): Promise<BotConfigView> {
  return call('/agent/bot-config', token);
}

export function saveBotConfig(
  token: string,
  patch: SaveBotConfigBodyValue,
): Promise<BotConfigView> {
  return call('/agent/bot-config', token, { method: 'POST', body: JSON.stringify(patch) });
}

export function fetchBotConfigHistory(
  token: string,
  opts: {
    field?: 'prompt' | 'rules' | 'tools_config' | 'limits_config';
    limit?: number;
    cursor?: string;
  } = {},
): Promise<ChangeLogHistoryResponse> {
  const params = new URLSearchParams();
  if (opts.field) params.set('field', opts.field);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', opts.cursor);
  const query = params.toString();
  return call(`/agent/bot-config/history${query ? `?${query}` : ''}`, token);
}

export function rollbackBotConfig(
  token: string,
  input: RollbackBotConfigBodyValue,
): Promise<BotConfigView> {
  return call('/agent/bot-config/rollback', token, { method: 'POST', body: JSON.stringify(input) });
}
