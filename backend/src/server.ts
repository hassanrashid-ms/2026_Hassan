// This MUST run before anything below is imported, not merely before it is used:
// `./db/client.ts` (imported transitively via `./app.ts`) reads `getEnv()` at module
// top level to build its connection pool, and static `import` statements are fully
// evaluated before this file's own body runs — so a call interleaved among top-level
// imports would run too late. Dynamic `import()` defers evaluation to this exact
// point, which is what makes the ordering here actually work. Same pattern as
// db/seed.ts and db/setup.ts.
const { loadRootEnv } = await import('./env/loadRootEnv.ts');
loadRootEnv(import.meta.url);

const { createApp } = await import('./app.ts');
const { getEnv } = await import('./env.ts');
const { registerJobs } = await import('./shared/jobs/queue.ts');
const { createSocketServer } = await import('./shared/realtime/socketServer.ts');
const { logger } = await import('./shared/logging/logger.ts');
const { initLangfuse, shutdownLangfuse } = await import('./shared/observability/langfuse.ts');

initLangfuse();

const port = getEnv().PORT;
const server = createApp().listen(port, () => {
  logger.info('server', `api listening on http://localhost:${port}`);
});
createSocketServer(server);

const jobs = await registerJobs();

const SHUTDOWN_TIMEOUT_MS = 5000;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // `node --watch` sends this on every file save and waits for the process to exit before
    // spawning the next one. Any of the three steps below hanging (a slow Redis/BullMQ close, a
    // stalled network flush to Langfuse, open keep-alive sockets blocking server.close) used to
    // wedge dev indefinitely: no crash, no log, just a port nothing was ever going to bind again.
    // Logging before each step means the next hang at least names which one it was.
    const forceExit = setTimeout(() => {
      logger.error('server', `graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    void (async () => {
      try {
        logger.info('server', 'shutdown: closing jobs');
        await jobs.close();
        logger.info('server', 'shutdown: closing langfuse');
        await shutdownLangfuse();
        logger.info('server', 'shutdown: closing http server');
        await new Promise<void>((resolve) => server.close(() => resolve()));
        clearTimeout(forceExit);
        process.exit(0);
      } catch (err) {
        const error = err as Error;
        logger.error('server', 'error during graceful shutdown', {
          message: error.message,
          stack: error.stack,
        });
        clearTimeout(forceExit);
        process.exit(1);
      }
    })();
  });
}
