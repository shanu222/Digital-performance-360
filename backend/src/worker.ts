/**
 * Railway worker service: runs the cron scheduler + Postgres job queue.
 * Keeps collecting historical data whether or not anyone is logged in.
 */
import http from 'node:http';
import { logger } from './lib/logger.js';
import { runMigrations } from './db/migrate.js';
import { closeDb, pingDb } from './db/client.js';
import { startScheduler, stopWorkerLoop } from './services/sync/runner.js';

async function main() {
  if (process.env.SKIP_MIGRATIONS !== 'true') await runMigrations();
  await startScheduler();

  // Minimal health endpoint so Railway can health-check the worker
  const port = Number(process.env.PORT ?? 8081);
  http
    .createServer(async (req, res) => {
      if (req.url === '/health' || req.url === '/api/health') {
        const ok = await pingDb();
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok, service: 'dp360-worker' }));
      }
      res.writeHead(404).end();
    })
    .listen(port, () => logger.info({ port }, 'Worker health endpoint listening'));

  const shutdown = async () => {
    stopWorkerLoop();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'Worker failed to start');
  process.exit(1);
});
