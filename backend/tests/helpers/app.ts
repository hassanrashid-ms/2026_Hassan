import type { Express } from 'express'
import request from 'supertest'
import { createApp } from '../../src/app.ts'
import { signPlayerToken, type PlayerClaims } from '../../src/auth/playerToken.ts'

export const app = createApp()

/**
 * A supertest agent bound to a given app instance. Declared per the brief's
 * interface list even though nothing in this task's own tests calls it yet —
 * Task 7 (the player-token middleware / X-Support-Workspace cross-check) is the
 * expected first caller.
 */
export function agentFor(target: Express = app): ReturnType<typeof request.agent> {
  return request.agent(target)
}

export async function mintToken(claims: PlayerClaims, ttlSeconds = 900): Promise<string> {
  return signPlayerToken(claims, ttlSeconds)
}
