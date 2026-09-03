import type { Request } from 'express';

export function ipKey(req: Request): string {
  return req.ip ?? 'unknown';
}

export function agentIdentityKey(req: Request): string {
  return req.agent?.agentId ?? 'unknown';
}

export function playerIdentityKey(req: Request): string {
  return req.player?.playerId ?? 'unknown';
}
