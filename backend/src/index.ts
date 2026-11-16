import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/client.js';
import { ensureAdminUser } from './services/auth.js';
import { startScheduler, stopWorkerLoop } from './services/sync/runner.js';

async function main() {
  if (process.env.SKIP_MIGRATIONS !== 'true') await runMigrations();
  await ensureAdminUser();
  const app = createApp();
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'DP360 API listening'));

  // Single-service deployments may run the scheduler inside the API process.
  if (env.RUN_SCHEDULER_IN_API) await startScheduler();

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'Shutting down');
    stopWorkerLoop();
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'Fatal startup error');
  process.exit(1);
});
