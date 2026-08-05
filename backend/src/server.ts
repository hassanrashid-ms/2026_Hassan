import { dirname, join } from 'node:path'
import { config as loadDotenv } from 'dotenv'

// `pnpm --filter @support/api dev` sets cwd to backend/, but .env lives at the repo
// root one level above. This MUST run before anything below is imported, not merely
// before it is used: `./db/client.ts` (imported transitively via `./app.ts`) reads
// `getEnv()` at module top level to build its connection pool, and static `import`
// statements are fully evaluated before this file's own body runs — so a
// `loadDotenv()` call interleaved among top-level imports would run too late.
// Dynamic `import()` defers evaluation to this exact point, which is what makes the
// ordering here actually work. Same pattern as db/seed.ts.
loadDotenv({ path: join(dirname(new URL(import.meta.url).pathname), '..', '..', '.env') })

const { createApp } = await import('./app.ts')
const { getEnv } = await import('./env.ts')
const { registerJobs } = await import('./jobs/queue.ts')

const port = getEnv().PORT
const server = createApp().listen(port, () => {
  console.log(`api listening on http://localhost:${port}`)
})

const jobs = await registerJobs()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await jobs.close()
      server.close(() => process.exit(0))
    })()
  })
}
