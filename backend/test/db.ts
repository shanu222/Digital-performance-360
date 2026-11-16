import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../src/db/schema.js';
import { setDb, type Db } from '../src/db/client.js';
import { clearSettingsCache } from '../src/services/settings.js';

/** Fresh in-memory PostgreSQL (PGlite) with real migrations applied. */
export async function freshDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  setDb(db as unknown as Db);
  clearSettingsCache();
  return { db, client };
}
