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
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    throw new ApiError(body?.error?.message ?? `Request failed with ${res.status}`, res.status)
  }
  return (await res.json()) as T
}
