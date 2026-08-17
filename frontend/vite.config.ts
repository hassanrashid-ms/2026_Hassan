import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// The brief's `import { defineConfig } from 'vite'` no longer typechecks against the
// installed vite@8/vitest@4: vite's own UserConfig type has no `test` field. vitest/config
// re-exports vite's defineConfig after augmenting that type with the `test` block, which is
// the documented way to merge the two config shapes — same runtime behaviour, correct types.
import { defineConfig, type Plugin } from 'vitest/config'

/*
 * Serves webview.html for every /embed/support path.
 *
 * Vite's SPA fallback only knows about index.html, so without this the player
 * surface's URL would return the agent console's document. Registered inside
 * configureServer's body, which runs BEFORE Vite's internal middlewares — after
 * them the fallback has already answered.
 *
 * Applied to the preview server too: `vite preview` serves the real build, so a
 * rewrite that only existed in dev would make the built output look broken.
 *
 * PRODUCTION NOTE: nothing in this repo serves dist/ yet — cloudflared points
 * straight at Vite. Whatever eventually hosts the build must do this same
 * rewrite, or /embed/support will serve the console's HTML.
 */
const EMBED_PREFIX = '/embed/support'

function serveWebviewEntry(): Plugin {
  const rewrite = (req: { url?: string }) => {
    // Path only — the SDK's token rides in the URL fragment and never reaches a
    // server, and query strings are not read by any webview route.
    const path = req.url?.split('?')[0]
    if (path === EMBED_PREFIX || path?.startsWith(`${EMBED_PREFIX}/`)) {
      req.url = '/webview.html'
    }
  }

  return {
    name: 'serve-webview-entry',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req)
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req)
        next()
      })
    },
  }
}

export default defineConfig({
  // tailwindcss() is a build-time plugin only. It compiles whichever stylesheet
  // does `@import "tailwindcss"` — that is webview.css alone. styles.css is
  // untouched, so the agent console never receives preflight.
  plugins: [react(), tailwindcss(), serveWebviewEntry()],
  build: {
    rollupOptions: {
      // Two entry documents, two independent module graphs. This is what makes
      // the surface split structural: no agent-console module is reachable from
      // webview.html, and vice versa.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        webview: fileURLToPath(new URL('./webview.html', import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: { port: 5173, strictPort: true, allowedHosts: true },
  // jsdom for the whole suite: the pure-function tests (boot, chatReconcile,
  // articleSearch) are environment-agnostic and pass unchanged under it, and
  // component tests need a DOM. One environment beats per-file pragmas.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
