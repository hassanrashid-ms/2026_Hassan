import http from 'node:http'
import type { Express } from 'express'
import request from 'supertest'

/**
 * One listening server per app, instead of one per request.
 *
 * Handed an Express app, supertest creates a fresh `http.Server`, listens on an
 * ephemeral port, and closes it once the response lands. The suite makes ~109
 * such requests, so a full run churns through ~109 bind/close cycles. Ports come
 * back around, and a connection to a port whose previous occupant is still
 * winding down fails as `ECONNRESET`, `socket hang up`, or
 * `Parse Error: Expected HTTP/, RTSP/ or ICE/` — always on a test whose
 * assertions are correct, which is why it read as random.
 *
 * Handed an already-listening server, supertest reuses it and never closes it.
 * `server.address()` is populated synchronously by `listen(0)`, so supertest's
 * constructor — which reads the address immediately — sees a bound port and does
 * not try to listen again.
 *
 * Test files import this as `request`, so the ~109 `request(app)` call sites are
 * unchanged: only the import swaps.
 */
const servers = new Map<Express, http.Server>()

export function req(target: Express | string): ReturnType<typeof request> {
  // A URL string addresses a server the test already started and owns.
  if (typeof target === 'string') return request(target)

  let server = servers.get(target)
  if (!server) {
    server = http.createServer(target)
    server.listen(0)
    servers.set(target, server)
  }
  return request(server)
}

/** Registered globally in tests/setup.ts — an open server would hang the worker. */
export async function closeTestServers(): Promise<void> {
  const open = [...servers.values()]
  servers.clear()
  await Promise.all(
    open.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
}
