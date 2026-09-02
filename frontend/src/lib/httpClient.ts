const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

/**
 * Dev/staging only: VITE_API_BASE_URL sometimes points at an ngrok free-tier
 * tunnel (for phone/Unity testing through cloudflared/ngrok — see vite.config.ts).
 * That tier serves an HTML "click to continue" interstitial — still a 200 — to
 * any request lacking this header, which .json() then fails to parse. Sending
 * it unconditionally is a no-op against a real backend, which never looks at it.
 */
const NGROK_SKIP_WARNING_HEADER = { 'ngrok-skip-browser-warning': 'true' };

/**
 * Carries the HTTP status alongside the message so a caller can tell a 404 from
 * any other failure. Still an Error with the same message, so every existing
 * `catch`/`error.message` site is unaffected.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * `workspaceId`, when supplied, becomes an `X-Workspace-Id` header. It matters
 * only for an admin session — a regular agent's workspace comes from their own
 * JWT and the server never reads this header for them — so passing it
 * unconditionally is harmless. See
 * 2026-08-21-superadmin-workspace-console-access-design.md.
 */
export async function apiCall<T>(
  path: string,
  token: string,
  init: RequestInit = {},
  workspaceId?: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(workspaceId ? { 'X-Workspace-Id': workspaceId } : {}),
        ...NGROK_SKIP_WARNING_HEADER,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    // fetch itself rejects on a network failure (offline, DNS, CORS) before any
    // response exists — status 0 marks that as distinct from a real HTTP status,
    // so callers can tell "server said no" from "never reached the server".
    throw new ApiError('Network error — check your connection and try again.', 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiError(body?.error?.message ?? `Request failed with ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

/**
 * Same request/error contract as apiCall, but for endpoints whose 200
 * response is a binary body (e.g. a zip download) rather than JSON — calling
 * res.json() on those would throw on the caller's behalf for no reason.
 */
export async function apiCallBlob(
  path: string,
  token: string,
  init: RequestInit = {},
  workspaceId?: string,
): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(workspaceId ? { 'X-Workspace-Id': workspaceId } : {}),
        ...NGROK_SKIP_WARNING_HEADER,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError('Network error — check your connection and try again.', 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiError(body?.error?.message ?? `Request failed with ${res.status}`, res.status);
  }
  return res.blob();
}
