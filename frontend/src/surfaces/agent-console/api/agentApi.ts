import type {
  AgentArticleDetail,
  AgentConversationSummary,
  AgentConversationsResponse,
  AgentMessagesResponse,
  AgentMessageView,
  AgentArticlesResponse,
  AgentConversationContextResponse,
  AgentConversationDetail,
  ArchiveDeclaredFieldResponse,
  ArchiveIntentResponse,
  ArchiveSubintentResponse,
  ArticleAttachmentView,
  ArticleVersionSnapshotView,
  ArticleVersionsListResponse,
  AskResolvedResponse,
  AttachTagResponse,
  BotConfigView,
  BotConfigVersionsListResponse,
  BotConfigVersionSnapshotView,
  ClaimResponse,
  TakeOverResponse,
  ConversationPriority,
  CreateDeclaredFieldResponse,
  CreateFormResponse,
  CreateIntentResponse,
  CreateSubintentResponse,
  CreateTagResponse,
  DeactivateDeclaredFieldResponse,
  DeclaredFieldsResponse,
  DeclaredFieldType,
  DetachTagResponse,
  EscalateResponse,
  ForceResolveResponse,
  FormDetail,
  FormField,
  FormsListResponse,
  IntentsResponse,
  ReactivateDeclaredFieldResponse,
  MergeSubintentResponse,
  MoveSubintentResponse,
  RenameIntentResponse,
  RenameSubintentResponse,
  SaveBotConfigBodyValue,
  TagView,
  UnarchiveIntentResponse,
  UnarchiveSubintentResponse,
  UnescalateResponse,
  UpdateDeclaredFieldResponse,
} from '@support/types';
import { apiCall } from '../../../lib/httpClient.ts';
import { loadAgentSession } from '../lib/agentSession.ts';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

export type DevAgentOption = { id: string; email: string; display_name: string };
export type DevLoginResponse = {
  token: string;
  agent: { id: string; display_name: string };
};

export type MembershipView = {
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  role: 'agent' | 'team_lead' | 'admin';
};

export function fetchMemberships(token: string): Promise<{ memberships: MembershipView[] }> {
  return call('/agent/memberships', token);
}

export type GlobalInboxTicket = AgentConversationSummary & {
  workspace: { id: string; slug: string; name: string };
};

export type GlobalInboxResponse = {
  conversations: GlobalInboxTicket[];
  failed_workspaces: string[];
};

export function fetchGlobalInbox(token: string): Promise<GlobalInboxResponse> {
  return call('/agent/global-inbox', token);
}

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
  | 'unassigned'
  | 'mine'
  | 'agentAssigned'
  | 'botHandling'
  | 'escalated'
  | 'resolved'
  | 'closed'
  | 'all';

export type TicketsQueryFilters = {
  q?: string;
  priority?: string[];
  labelIds?: string[];
  subintentIds?: string[];
  assigneeIds?: string[];
  olderThanHours?: number;
  statuses?: string[];
  createdFrom?: string;
  createdTo?: string;
};

function buildTicketsQuery(
  status: ConversationListFilter,
  filters?: TicketsQueryFilters,
  cursor?: string,
): string {
  const params = new URLSearchParams({ status });
  if (filters?.q) params.set('q', filters.q);
  if (filters?.priority?.length) filters.priority.forEach((p) => params.append('priority', p));
  if (filters?.labelIds?.length) filters.labelIds.forEach((l) => params.append('labelIds', l));
  if (filters?.subintentIds?.length)
    filters.subintentIds.forEach((s) => params.append('subintentIds', s));
  if (filters?.assigneeIds?.length)
    filters.assigneeIds.forEach((a) => params.append('assigneeIds', a));
  if (filters?.olderThanHours) params.set('olderThanHours', String(filters.olderThanHours));
  if (filters?.statuses?.length) filters.statuses.forEach((s) => params.append('statuses', s));
  if (filters?.createdFrom) params.set('createdFrom', filters.createdFrom);
  if (filters?.createdTo) params.set('createdTo', filters.createdTo);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export function fetchInbox(
  token: string,
  status: ConversationListFilter,
  filters?: TicketsQueryFilters,
  cursor?: string,
): Promise<AgentConversationsResponse> {
  return call(`/agent/conversations?${buildTicketsQuery(status, filters, cursor)}`, token);
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

export function setConversationPriority(
  token: string,
  conversationId: string,
  priority: string,
): Promise<{ updated: boolean }> {
  return call(`/agent/conversations/${conversationId}/priority`, token, {
    method: 'PATCH',
    body: JSON.stringify({ priority }),
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

export type RequestUploadResult = { key: string; upload_url: string; expires_at: string };

export function requestUpload(
  token: string,
  file: { filename: string; contentType: string; byteSize: number },
): Promise<RequestUploadResult> {
  return call(`/agent/uploads`, token, {
    method: 'POST',
    body: JSON.stringify({
      filename: file.filename,
      content_type: file.contentType,
      byte_size: file.byteSize,
    }),
  });
}

/**
 * XHR, not fetch — fetch has no upload-progress event, and the pretty
 * uploading UI needs a real percentage, not a fake one.
 */
export function putFileToUploadUrl(
  uploadUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new Error(`Upload failed with ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
}

export function cancelUpload(token: string, key: string): Promise<void> {
  return call(`/agent/uploads/${key}`, token, { method: 'DELETE' });
}

export function sendAgentMessage(
  token: string,
  conversationId: string,
  body: string,
  visibility?: 'public' | 'internal',
  attachment?: { key: string; filename: string; mimeType: string; byteSize: number },
): Promise<{ message: AgentMessageView }> {
  return call(`/agent/messages`, token, {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: conversationId,
      body,
      visibility,
      attachment: attachment
        ? {
            key: attachment.key,
            filename: attachment.filename,
            mime_type: attachment.mimeType,
            byte_size: attachment.byteSize,
          }
        : undefined,
    }),
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
export type PresenceStatus = 'online' | 'away' | 'offline';
export type DisplayStatus = PresenceStatus | 'on_leave';

export type AgentWorkloadEntry = {
  agentId: string;
  agentName: string;
  openCount: number;
  resolved7d: number;
  status: DisplayStatus;
  onLeaveSince: string | null;
  onLeaveUntil: string | null;
};

export type AgentWorkloadResponse = {
  agents: AgentWorkloadEntry[];
};

export function fetchWorkload(token: string): Promise<AgentWorkloadResponse> {
  return call('/agent/workload', token);
}

export function fetchPresence(token: string): Promise<{ status: PresenceStatus }> {
  return call('/agent/presence', token);
}

export function updatePresence(token: string, status: 'online' | 'away'): Promise<void> {
  return call('/agent/presence', token, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function setAgentLeave(
  token: string,
  agentId: string,
  onLeave: boolean,
  days?: number,
): Promise<{ status: DisplayStatus; onLeaveSince: string | null; onLeaveUntil: string | null }> {
  return call(`/agent/agents/${agentId}/leave`, token, {
    method: 'PATCH',
    body: JSON.stringify({ onLeave, days }),
  });
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

export function unarchiveIntent(token: string, id: string): Promise<UnarchiveIntentResponse> {
  return call(`/agent/intents/${id}/unarchive`, token, { method: 'POST' });
}

export function fetchDeclaredFields(token: string): Promise<DeclaredFieldsResponse> {
  return call('/agent/declared-fields', token);
}

export function createDeclaredField(
  token: string,
  input: { key: string; label: string; type: DeclaredFieldType },
): Promise<CreateDeclaredFieldResponse> {
  return call('/agent/declared-fields', token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateDeclaredField(
  token: string,
  id: string,
  patch: { label?: string; type?: DeclaredFieldType },
): Promise<UpdateDeclaredFieldResponse> {
  return call(`/agent/declared-fields/${id}`, token, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deactivateDeclaredField(
  token: string,
  id: string,
): Promise<DeactivateDeclaredFieldResponse> {
  return call(`/agent/declared-fields/${id}/deactivate`, token, { method: 'POST' });
}

export function reactivateDeclaredField(
  token: string,
  id: string,
): Promise<ReactivateDeclaredFieldResponse> {
  return call(`/agent/declared-fields/${id}/reactivate`, token, { method: 'POST' });
}

export function archiveDeclaredField(
  token: string,
  id: string,
): Promise<ArchiveDeclaredFieldResponse> {
  return call(`/agent/declared-fields/${id}/archive`, token, { method: 'POST' });
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

export function unarchiveSubintent(
  token: string,
  id: string,
): Promise<UnarchiveSubintentResponse> {
  return call(`/agent/subintents/${id}/unarchive`, token, { method: 'POST' });
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

export function unarchiveArticle(token: string, id: string): Promise<AgentArticleDetail> {
  return call(`/agent/articles/${id}/unarchive`, token, { method: 'POST' });
}

export function finalizeArticleAttachment(
  token: string,
  articleId: string,
  input: { key: string; filename: string; mimeType: string; byteSize: number; draft?: boolean },
): Promise<ArticleAttachmentView> {
  return call(`/agent/articles/${articleId}/attachments`, token, {
    method: 'POST',
    body: JSON.stringify({
      key: input.key,
      filename: input.filename,
      mime_type: input.mimeType,
      byte_size: input.byteSize,
      draft: input.draft,
    }),
  });
}

export function saveArticleDraft(
  token: string,
  articleId: string,
  patch: { title?: string; body?: string; keywords?: string[] },
): Promise<AgentArticleDetail> {
  return call(`/agent/articles/${articleId}/draft`, token, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function discardArticleDraft(token: string, articleId: string): Promise<AgentArticleDetail> {
  return call(`/agent/articles/${articleId}/draft`, token, { method: 'DELETE' });
}

export function fetchArticleVersions(
  token: string,
  articleId: string,
  opts: { limit?: number; cursor?: number } = {},
): Promise<ArticleVersionsListResponse> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', String(opts.cursor));
  const query = params.toString();
  return call(`/agent/articles/${articleId}/versions${query ? `?${query}` : ''}`, token);
}

export function fetchArticleVersion(
  token: string,
  articleId: string,
  version: number,
): Promise<ArticleVersionSnapshotView> {
  return call(`/agent/articles/${articleId}/versions/${version}`, token);
}

export function restoreArticleVersion(
  token: string,
  articleId: string,
  version: number,
): Promise<AgentArticleDetail> {
  return call(`/agent/articles/${articleId}/versions/${version}/restore`, token, { method: 'POST' });
}

export function removeArticleAttachment(
  token: string,
  articleId: string,
  attachmentId: string,
): Promise<AgentArticleDetail> {
  return call(`/agent/articles/${articleId}/attachments/${attachmentId}`, token, {
    method: 'DELETE',
  });
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

export function forceResolveConversation(
  token: string,
  conversationId: string,
): Promise<ForceResolveResponse> {
  return call(`/agent/conversations/${conversationId}/force-resolve`, token, { method: 'POST' });
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

export function fetchBotConfigVersions(
  token: string,
  opts: { limit?: number; cursor?: number } = {},
): Promise<BotConfigVersionsListResponse> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', String(opts.cursor));
  const query = params.toString();
  return call(`/agent/bot-config/versions${query ? `?${query}` : ''}`, token);
}

export function fetchBotConfigVersion(
  token: string,
  version: number,
): Promise<BotConfigVersionSnapshotView> {
  return call(`/agent/bot-config/versions/${version}`, token);
}

export function rollbackBotConfigVersion(token: string, version: number): Promise<BotConfigView> {
  return call('/agent/bot-config/rollback', token, {
    method: 'POST',
    body: JSON.stringify({ version }),
  });
}

/**
 * `/agent/workspace-settings` is a local frontend-side contract, not sourced
 * from `@support/types`, mirroring AgentWorkloadResponse above.
 */
export type WorkspaceSettingsView = {
  max_assigned_tickets: number;
  auto_close_days: number;
  inactivity_window_hours: number;
  form_timeout_minutes: number;
};

export function fetchWorkspaceSettings(token: string): Promise<WorkspaceSettingsView> {
  return call('/agent/workspace-settings', token);
}

export function saveWorkspaceSettings(
  token: string,
  patch: WorkspaceSettingsView,
): Promise<WorkspaceSettingsView> {
  return call('/agent/workspace-settings', token, {
    method: 'POST',
    body: JSON.stringify(patch),
  });
}
