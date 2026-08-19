const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'

/**
 * Carries the HTTP status alongside the message so a caller can tell a 404 from
 * any other failure. Still an Error with the same message, so every existing
 * `catch`/`error.message` site is unaffected.
 */
export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function apiCall<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
  } catch {
    // fetch itself rejects on a network failure (offline, DNS, CORS) before any
    // response exists — status 0 marks that as distinct from a real HTTP status,
    // so callers can tell "server said no" from "never reached the server".
    throw new ApiError('Network error — check your connection and try again.', 0)
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    throw new ApiError(body?.error?.message ?? `Request failed with ${res.status}`, res.status)
  }
  return (await res.json()) as T
}
