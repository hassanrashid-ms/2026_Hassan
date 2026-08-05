import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { defineConfig } from 'vitest/config'

// Loaded at the top level of the config file (main process), not inside globalSetup or a
// test file, so it runs exactly once and vitest forwards the mutated process.env to worker
// processes. Both tests/globalSetup.ts (runs in the main process) and ordinary test files
// (run in a worker) call getEnv(), so both need this. Verified by running each in isolation.
//
// `.env.test` lives at the repo root alongside `.env`/`.env.example`, one level above this
// package, not in `backend/`. `pnpm --filter @support/api test` sets cwd to `backend/`, so a
// plain relative path here would silently miss the file — resolve from this file's own
// location instead of trusting cwd.
const here = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(here, '../.env.test') })

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/globalSetup.ts'],
    // Vitest 4 removed `poolOptions.forks.singleFork`; per the migration guide,
    // `fileParallelism: false` is the top-level replacement (it forces maxWorkers
    // to 1). We keep `pool: 'forks'` alongside it. Every test shares one Postgres
    // database and RLS state lives in transactions, so this must stay a single
    // worker process — do not restore parallelism here.
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
})
