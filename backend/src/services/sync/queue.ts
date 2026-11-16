import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, rawRows } from '../../db/client.js';
import { syncJobs, syncLogs } from '../../db/schema.js';
import { logger, scrub } from '../../lib/logger.js';

export type JobService =
  | 'discovery'
  | 'search_console'
  | 'ga4'
  | 'admob'
  | 'play_reporting'
  | 'alerts'
  | 'ai_analysis'
  | 'daily_report'
  | 'summary_email';

export type Job = typeof syncJobs.$inferSelect;

/**
 * Enqueue a job. The partial unique index (service, target_id) WHERE status IN
 * ('pending','running') guarantees no duplicate active job; if one exists it is returned.
 */
export async function enqueue(
  service: JobService,
  opts: { targetId?: string; trigger?: 'scheduled' | 'manual' | 'backfill'; params?: Record<string, unknown>; runAfter?: Date } = {},
): Promise<{ job: Job; created: boolean }> {
  const targetId = opts.targetId ?? '';
  const rows = await rawRows<{ id: string }>(sql`
    insert into sync_jobs (service, target_id, trigger, params, run_after)
    values (${service}, ${targetId}, ${opts.trigger ?? 'scheduled'}, ${JSON.stringify(opts.params ?? {})}::jsonb, ${(opts.runAfter ?? new Date()).toISOString()}::timestamptz)
    on conflict (service, target_id) where status in ('pending','running') do nothing
    returning id`);
  if (rows[0]) {
    const [job] = await db.select().from(syncJobs).where(eq(syncJobs.id, rows[0].id));
    return { job, created: true };
  }
  const [existing] = await db
    .select()
    .from(syncJobs)
    .where(and(eq(syncJobs.service, service), eq(syncJobs.targetId, targetId), inArray(syncJobs.status, ['pending', 'running'])));
  return { job: existing, created: false };
}

/** Atomically claim the next runnable job (safe with multiple workers). */
export async function claimNext(): Promise<Job | null> {
  const rows = await rawRows<{ id: string }>(sql`
    update sync_jobs set status = 'running', started_at = now(), heartbeat_at = now(), attempts = attempts + 1, error = null
    where id = (
      select id from sync_jobs
      where status = 'pending' and run_after <= now()
      order by run_after asc, created_at asc
      for update skip locked
      limit 1
    )
    returning id`);
  if (!rows[0]) return null;
  const [job] = await db.select().from(syncJobs).where(eq(syncJobs.id, rows[0].id));
  return job ?? null;
}

export async function heartbeat(jobId: string, progress?: number) {
  await db
    .update(syncJobs)
    .set({ heartbeatAt: new Date(), ...(progress != null ? { progress: Math.max(0, Math.min(100, Math.round(progress))) } : {}) })
    .where(eq(syncJobs.id, jobId));
}

export async function complete(jobId: string, status: 'success' | 'partial', result: unknown, error?: string) {
  await db
    .update(syncJobs)
    .set({ status, progress: 100, finishedAt: new Date(), result: result as Record<string, unknown>, error: error ? scrub(error).slice(0, 4000) : null })
    .where(eq(syncJobs.id, jobId));
}

/** Failure with exponential backoff; becomes 'failed' after max attempts. */
export async function fail(job: Job, error: string, retryable: boolean) {
  const msg = scrub(error).slice(0, 4000);
  if (retryable && job.attempts < job.maxAttempts) {
    const delayMs = Math.min(60 * 60_000, 2 ** job.attempts * 60_000);
    await db
      .update(syncJobs)
      .set({ status: 'pending', runAfter: new Date(Date.now() + delayMs), error: msg, heartbeatAt: null })
      .where(eq(syncJobs.id, job.id));
    return 'retrying' as const;
  }
  await db.update(syncJobs).set({ status: 'failed', finishedAt: new Date(), error: msg }).where(eq(syncJobs.id, job.id));
  return 'failed' as const;
}

/** Jobs whose worker died (no heartbeat for 20 min) go back to the queue. */
export async function recoverStaleJobs() {
  const rows = await rawRows<{ id: string }>(sql`
    update sync_jobs set status = 'pending', run_after = now(), error = 'Recovered after worker interruption'
    where status = 'running' and coalesce(heartbeat_at, started_at) < now() - interval '20 minutes'
    returning id`);
  if (rows.length) logger.warn({ count: rows.length }, 'Recovered stale sync jobs');
  return rows.length;
}

export async function log(jobId: string | null, level: 'info' | 'warn' | 'error', message: string, context?: Record<string, unknown>) {
  try {
    await db.insert(syncLogs).values({ jobId, level, message: scrub(message).slice(0, 4000), context: context ?? null });
  } catch (err) {
    logger.error({ err }, 'Failed writing sync log');
  }
}

export async function recentJobs(limit = 50) {
  return db.select().from(syncJobs).orderBy(desc(syncJobs.createdAt)).limit(limit);
}

export async function pruneOldJobs(days = 60) {
  await db.execute(sql`delete from sync_jobs where finished_at < now() - make_interval(days => ${days}) and status in ('success','partial','failed','cancelled')`);
}
