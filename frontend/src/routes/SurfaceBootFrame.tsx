/**
 * The first thing a player sees. Painted from the entry chunk, so it appears a
 * full network round trip before WebviewShell or SupportHome arrive.
 *
 * This used to be `null`, on the reasoning that the surface chunks are local and
 * resolve in a frame or two. That holds on a warm desktop dev server and nowhere
 * else: over a phone connection or a tunnel each chunk is its own round trip, and
 * `null` renders as a blank white page for the whole wait — the exact thing the
 * SDK's reveal handshake exists to prevent, reintroduced one layer up.
 *
 * Styling is inline rather than Tailwind on purpose. webview.css ships inside
 * WebviewShell's chunk (that import is what keeps the console free of Tailwind's
 * preflight), so at this point no theme token, utility class, or custom property
 * has loaded yet. Inline literals are the only thing that can paint here — hence
 * the hardcoded hex values, which mirror --color-accent / --color-accent-deep /
 * --color-bg in webview.css.
 */
export function SurfaceBootFrame() {
  return (
    <div
      aria-hidden
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100dvh',
        width: '100%',
        overflow: 'hidden',
        background: '#ffffff',
      }}
    >
      {/* Stands in for the hero: same gradient, so the real screen replacing it
          reads as the page filling in rather than as a second page. */}
      <div
        style={{
          height: '38%',
          minHeight: '11rem',
          background: 'linear-gradient(to bottom right, #7c3aed, #5b21b6)',
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1.25rem 1rem' }}>
        {['100%', '100%', '80%'].map((width, index) => (
          <div
            key={index}
            style={{
              height: '3.5rem',
              width,
              borderRadius: '1rem',
              background: '#f5f3fd',
            }}
          />
        ))}
      </div>
    </div>
  )
}
