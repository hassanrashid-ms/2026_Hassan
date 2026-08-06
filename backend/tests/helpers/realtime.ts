import { createServer } from 'node:http'
import { io as ioClient, type Socket } from 'socket.io-client'
import { app } from './app.ts'
import { closeSocketServer, createSocketServer } from '../../src/shared/realtime/socketServer.ts'

export async function startRealtimeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = createServer(app)
  createSocketServer(httpServer)
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))

  const address = httpServer.address()
  if (address === null || typeof address === 'string') {
    throw new Error('failed to bind an ephemeral port for the test realtime server')
  }

  return {
    url: `http://localhost:${address.port}`,
    // Each test in this file spins up its own server + Redis pub/sub pair
    // (see beforeEach in realtime.rooms.test.ts) — closing only the http
    // server would leak those Redis connections across the rest of the
    // single-worker test run (vitest.config.ts: fileParallelism: false).
    // closeSocketServer() closes `io`, which in turn closes the httpServer
    // it's attached to — an extra httpServer.close() here would double-close
    // it and throw "Server is not running".
    close: () => closeSocketServer(),
  }
}

export function connectClient(url: string, auth: { token: string; role: 'player' | 'agent' }): Socket {
  return ioClient(url, { auth, transports: ['websocket'], forceNew: true })
}
