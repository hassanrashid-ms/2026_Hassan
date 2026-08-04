import react from '@vitejs/plugin-react'
// The brief's `import { defineConfig } from 'vite'` no longer typechecks against the
// installed vite@8/vitest@4: vite's own UserConfig type has no `test` field. vitest/config
// re-exports vite's defineConfig after augmenting that type with the `test` block, which is
// the documented way to merge the two config shapes — same runtime behaviour, correct types.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  test: { environment: 'node' },
})
