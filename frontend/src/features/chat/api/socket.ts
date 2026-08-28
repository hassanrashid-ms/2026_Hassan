import { io, type Socket } from 'socket.io-client';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

export type SocketRole = 'player' | 'agent';

/**
 * `workspaceId` matters only for an admin session (no workspace_id claim in
 * their token — see 2026-08-21-superadmin-workspace-console-access-design.md);
 * the server ignores it for a regular agent, whose own claim wins. Harmless to
 * always pass it.
 */
export function createSocket(token: string, role: SocketRole, workspaceId?: string): Socket {
  return io(BASE, { auth: { token, role, workspaceId }, transports: ['websocket'] });
}
