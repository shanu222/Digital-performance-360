import cron, { type ScheduledTask } from 'node-cron';
import { errorMessage, logger } from '../../lib/logger.js';
import { isAuthError, isPermissionError } from '../../lib/retry.js';
import { getSettings, clearSettingsCache } from '../settings.js';
import { purgeExpiredSessions } from '../auth.js';
import { claimNext, complete, enqueue, fail, log, pruneOldJobs, recoverStaleJobs, type Job, type JobService } from './queue.js';
import { handleJob } from './handlers.js';
import { raiseNotification } from '../alerts.js';
import { todayIn } from '../../lib/dates.js';

const SERVICE_LABEL: Record<string, string> = {
  search_console: 'Search Console',
  ga4: 'Google Analytics',
  admob: 'AdMob',
  play_reporting: 'Google Play Reporting',
  discovery: 'Property discovery',
};

export async function runJob(job: Job) {
  logger.info({ jobId: job.id, service: job.service, target: job.targetId }, 'Job started');
  try {
    const r = await handleJob(job);
    await complete(job.id, r.status, r.result, r.error);
    logger.info({ jobId: job.id, status: r.status }, 'Job finished');
  } catch (err) {
    const msg = errorMessage(err);
    const nonRetryable = (err as { nonRetryable?: boolean }).nonRetryable || isAuthError(err) || isPermissionError(err);
    const outcome = await fail(job, msg, !nonRetryable);
    await log(job.id, 'error', msg);
    logger.error({ jobId: job.id, service: job.service, err: msg, outcome }, 'Job failed');
    if (outcome === 'failed' && SERVICE_LABEL[job.service]) {
      await raiseNotification({
        type: `${job.service}_sync_failure`,
        severity: 'warning',
        title: `${SERVICE_LABEL[job.service]} synchronization failed`,
        description: msg,
        recommendedAction: 'Check the Integrations page for connection status, then use "Synchronize now" to retry.',
        dedupeKey: `syncfail:${job.service}:${job.targetId}:${todayIn('UTC')}`,
      }).catch(() => undefined);
    }
  }
}

let running = 0;
let stopped = false;

/** Poll the Postgres queue; never blocks the API process. */
export function startWorkerLoop(maxParallel = 2, pollMs = 5000) {
  const tick = async () => {
    if (stopped) return;
    try {
      while (running < maxParallel) {
        const job = await claimNext();
        if (!job) break;
        running++;
        runJob(job).finally(() => {
          running--;
        });
      }
    } catch (err) {
      logger.error({ err: errorMessage(err) }, 'Worker poll failed');
    } finally {
      if (!stopped) setTimeout(tick, pollMs);
    }
  };
  setTimeout(tick, 1000);
}

export function stopWorkerLoop() {
  stopped = true;
}

let tasks: ScheduledTask[] = [];
let scheduleFingerprint = '';

/** (Re)register cron schedules from settings — evaluated in the configured time zone. */
export async function refreshSchedules() {
  clearSettingsCache();
  const settings = await getSettings();
  const fp = JSON.stringify([settings.schedule, settings.general.timezone]);
  if (fp === scheduleFingerprint) return;
  scheduleFingerprint = fp;
  tasks.forEach((t) => t.stop());
  tasks = [];
  const tz = settings.general.timezone;
  const plan: Array<[string, JobService]> = [
    [settings.schedule.discovery, 'discovery'],
    [settings.schedule.searchConsole, 'search_console'],
    [settings.schedule.ga4, 'ga4'],
    [settings.schedule.admob, 'admob'],
    [settings.schedule.playReporting, 'play_reporting'],
    [settings.schedule.dailyReport, 'daily_report'],
  ];
  for (const [expr, service] of plan) {
    if (!cron.validate(expr)) {
      logger.warn({ service, expr }, 'Invalid cron expression — schedule skipped');
      continue;
    }
    tasks.push(
      cron.schedule(
        expr,
        () => {
          enqueue(service, { trigger: 'scheduled' }).catch((err) => logger.error({ err: errorMessage(err), service }, 'Failed to enqueue'));
        },
        { timezone: tz },
      ),
    );
  }
  // housekeeping
  tasks.push(cron.schedule('*/10 * * * *', () => void recoverStaleJobs().catch(() => undefined)));
  tasks.push(cron.schedule('0 3 * * *', () => void Promise.all([pruneOldJobs(), purgeExpiredSessions()]).catch(() => undefined)));
  logger.info({ tz, jobs: plan.map((p) => `${p[1]}@${p[0]}`) }, 'Schedules registered');
}

export async function startScheduler() {
  await recoverStaleJobs();
  await refreshSchedules();
  // pick up schedule edits from the Settings page
  setInterval(() => void refreshSchedules().catch(() => undefined), 5 * 60_000);
  const settings = await getSettings();
  startWorkerLoop(2);
  logger.info({ concurrency: settings.schedule.concurrency }, 'Sync worker running');
}
