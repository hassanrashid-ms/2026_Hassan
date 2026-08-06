import { io, type Socket } from 'socket.io-client'

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'

export type SocketRole = 'player' | 'agent'

export function createSocket(token: string, role: SocketRole): Socket {
  return io(BASE, { auth: { token, role }, transports: ['websocket'] })
}
