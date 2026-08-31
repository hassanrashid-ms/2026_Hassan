import type { ConversationListFilter } from '../../api/agentApi.ts';

export type BoardQueue = Exclude<ConversationListFilter, 'mine' | 'all'>;

export const QUEUE_OPTIONS: { value: BoardQueue; title: string }[] = [
  { value: 'unassigned', title: 'Unassigned' },
  { value: 'botHandling', title: 'Bot Handling' },
  { value: 'agentAssigned', title: 'Agent Assigned' },
  { value: 'escalated', title: 'Escalated' },
  { value: 'resolved', title: 'Resolved' },
  { value: 'closed', title: 'Closed' },
];
