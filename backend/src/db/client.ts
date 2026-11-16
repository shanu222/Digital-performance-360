import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql, type SQL } from 'drizzle-orm';
import * as schema from './schema.js';
import { env, isProd } from '../config/env.js';

export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;

function createDb(): Db {
  pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    ssl: env.DATABASE_SSL || (isProd && /sslmode=require/.test(env.DATABASE_URL)) ? { rejectUnauthorized: false } : undefined,
  });
  return drizzle(pool, { schema });
}

/** Live binding: tests swap this for an in-memory PGlite database via setDb(). */
export let db: Db = env.NODE_ENV === 'test' ? (null as unknown as Db) : createDb();

export function setDb(next: Db) {
  db = next;
}

export async function closeDb() {
  await pool?.end();
}

export async function rawRows<T = Record<string, unknown>>(query: SQL): Promise<T[]> {
  const res = (await db.execute(query)) as unknown as { rows: T[] };
  return res.rows;
}

export async function pingDb(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

export { schema };
