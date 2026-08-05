// This MUST run before anything below is imported, not merely before it is used:
// `./db/client.ts` (imported transitively via `./app.ts`) reads `getEnv()` at module
// top level to build its connection pool, and static `import` statements are fully
// evaluated before this file's own body runs — so a call interleaved among top-level
// imports would run too late. Dynamic `import()` defers evaluation to this exact
// point, which is what makes the ordering here actually work. Same pattern as
// db/seed.ts and db/setup.ts.
const { loadRootEnv } = await import('./env/loadRootEnv.ts')
loadRootEnv(import.meta.url)

const { createApp } = await import('./app.ts')
const { getEnv } = await import('./env.ts')
const { registerJobs } = await import('./shared/jobs/queue.ts')

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
