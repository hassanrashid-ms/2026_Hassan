export type AssignmentVia = 'claim' | 'take_over' | 'reassign' | 'sweep' | 'bot_handoff';

export type TicketAssignedPayload = {
  ticket_number: number;
  priority: 'p1' | 'p2' | 'p3' | 'p4';
  via: AssignmentVia;
  workspace_name: string;
  workspace_slug: string;
};

export type NotificationView = {
  id: string;
  workspace_id: string;
  agent_id: string;
  type: string;
  conversation_id: string | null;
  payload: TicketAssignedPayload | Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

export type NotificationsResponse = {
  notifications: NotificationView[];
  unread_count: number;
};
