import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'

/**
 * Loads the repo-root `.env` regardless of which package's directory called it or
 * how deep the calling file sits. Resolves the root by walking up from the calling
 * module's own location until it finds `pnpm-workspace.yaml` — the actual marker of
 * "this is the repo root" — rather than counting `..` segments, which is only
 * correct for the caller's current depth and breaks silently the moment a file
 * moves.
 *
 * Must be reached via a dynamic `import()`, not a static one, and before any other
 * import that reads `getEnv()` at module scope (e.g. `db/client.ts`). Static imports
 * are fully evaluated before the importing file's own body runs, so a call
 * interleaved among top-level imports would run too late — dynamic import defers
 * evaluation to this exact point in the control flow, which is what makes the
 * ordering actually work. dotenv's default `override: false` makes a second call a
 * no-op when something (e.g. vitest's `globalSetup`) already populated
 * `process.env`, so calling this unconditionally is safe.
 */
export function loadRootEnv(fromUrl: string): void {
  let dir = dirname(fileURLToPath(fromUrl))
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error('loadRootEnv: reached the filesystem root without finding pnpm-workspace.yaml')
    }
    dir = parent
  }
  loadDotenv({ path: join(dir, '.env') })
}
