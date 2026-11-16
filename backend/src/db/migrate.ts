import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, closeDb } from './client.js';
import { logger } from '../lib/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from src/ (tsx) and dist/ (compiled): migrations live in <backend>/drizzle
export const migrationsFolder = path.resolve(here, '../../drizzle');

export async function runMigrations() {
  logger.info({ migrationsFolder }, 'Running database migrations');
  await migrate(db, { migrationsFolder });
  logger.info('Migrations complete');
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  runMigrations()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error({ err }, 'Migration failed');
      await closeDb();
      process.exit(1);
    });
}
