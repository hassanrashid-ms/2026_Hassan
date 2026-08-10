import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// The brief's `import { defineConfig } from 'vite'` no longer typechecks against the
// installed vite@8/vitest@4: vite's own UserConfig type has no `test` field. vitest/config
// re-exports vite's defineConfig after augmenting that type with the `test` block, which is
// the documented way to merge the two config shapes — same runtime behaviour, correct types.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // tailwindcss() is a build-time plugin only. It compiles whichever stylesheet
  // does `@import "tailwindcss"` — that is webview.css alone. styles.css is
  // untouched, so the agent console never receives preflight.
  plugins: [react(), tailwindcss()],
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
