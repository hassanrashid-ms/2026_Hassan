import { defineConfig } from 'vitest/config'

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
