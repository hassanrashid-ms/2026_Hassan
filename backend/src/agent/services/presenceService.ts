import {
  getPresenceStatus,
  setPresenceStatus,
  type LivePresenceStatus,
} from '../../shared/realtime/presence.ts';

export async function setAgentPresence(
  agentId: string,
  status: 'online' | 'away',
): Promise<{ ok: true } | { ok: false; reason: 'not_connected' }> {
  const applied = await setPresenceStatus(agentId, status);
  if (!applied) return { ok: false, reason: 'not_connected' };
  return { ok: true };
}

export async function getAgentPresence(agentId: string): Promise<LivePresenceStatus> {
  return getPresenceStatus(agentId);
}
