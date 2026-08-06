import { createServer } from 'node:http'
import { io as ioClient, type Socket } from 'socket.io-client'
import { app } from './app.ts'
import { createSocketServer } from '../../src/shared/realtime/socketServer.ts'

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
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

export function connectClient(url: string, auth: { token: string; role: 'player' | 'agent' }): Socket {
  return ioClient(url, { auth, transports: ['websocket'], forceNew: true })
}
