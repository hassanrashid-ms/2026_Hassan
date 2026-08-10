export type SurfaceBoot = {
  token: string
  sessionId: string
  entryPoint: string
}

/**
 * The SDK builds: {webviewBaseUrl}?session={sessionId}&entry={entryPoint}#t={jwt}
 * where webviewBaseUrl ends in /embed/support — the player surface is not served
 * from "/" so an agent-console user cannot wander into it.
 *
 * Only the token goes in the fragment: fragments never reach the server in a request
 * line, stay out of proxy and access logs, and are not forwarded in a Referer.
 */
export function readBoot(location: { search: string; hash: string }): SurfaceBoot | null {
  const query = new URLSearchParams(location.search)
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''))

  const token = fragment.get('t')
  const sessionId = query.get('session')
  if (!token || !sessionId) return null

  return { token, sessionId, entryPoint: query.get('entry') || 'unknown' }
}

/**
 * Called immediately after readBoot. The fragment is out of server logs by
 * construction, but it stays in browser history and in anything the player
 * screenshots, so it should not outlive the read.
 */
export function scrubToken(history: History, location: Location): void {
  history.replaceState(null, '', `${location.pathname}${location.search}`)
}
