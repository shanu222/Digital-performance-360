import pLimit from 'p-limit';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { searchConsoleProperties, ga4Properties, admobAccounts, playConsoleApps } from '../../db/schema.js';
import { addDays, todayIn } from '../../lib/dates.js';
import { errorMessage, logger } from '../../lib/logger.js';
import { isAuthError } from '../../lib/retry.js';
import { getSettings } from '../settings.js';
import { getActiveGoogleAccount, getPlayServiceAccount, markGoogleRevoked, setServiceStatus } from '../google/oauth.js';
import { discoverSearchConsoleProperties, syncSearchConsoleProperty, ensureWebsitesForSelected } from '../google/searchConsole.js';
import { discoverGa4Properties, syncGa4Property } from '../google/ga4.js';
import { discoverAdmob, syncAdmobAccount } from '../google/admob.js';
import { discoverPlayApps, syncPlayApp, playFreshness } from '../google/playReporting.js';
import { evaluateAlerts, raiseNotification } from '../alerts.js';
import { runDailyAnalysis } from '../ai.js';
import { generateDailyReport, sendSummaryEmail } from '../reports/daily.js';
import { enqueue, heartbeat, log, type Job } from './queue.js';

export interface HandlerResult {
  status: 'success' | 'partial';
  result: Record<string, unknown>;
  error?: string;
}

/** Incremental window: initial history on first sync, otherwise re-fetch the last N days to absorb reporting delays. */
export function syncWindow(lastDataDate: string | null, today: string, backfillDays: number, initialDays: number, endOffset = 0, params?: Record<string, unknown>) {
  const end = typeof params?.end === 'string' ? params.end : addDays(today, -endOffset);
  if (typeof params?.start === 'string') return { start: params.start, end };
  if (!lastDataDate) return { start: addDays(end, -(initialDays - 1)), end };
  const fromLast = addDays(lastDataDate < end ? lastDataDate : end, -backfillDays);
  return { start: fromLast, end };
}

async function runTargets<T extends { id: string; label: string }>(
  job: Job,
  targets: T[],
  concurrency: number,
  fn: (t: T) => Promise<unknown>,
  onError: (t: T, msg: string) => Promise<void>,
): Promise<HandlerResult> {
  const limit = pLimit(concurrency);
  let done = 0;
  const ok: Record<string, unknown> = {};
  const errors: string[] = [];
  let authFailure: string | null = null;
  await Promise.all(
    targets.map((t) =>
      limit(async () => {
        if (authFailure) return; // stop hammering Google once auth is known to be broken
        try {
          ok[t.label] = await fn(t);
          await log(job.id, 'info', `Synced ${t.label}`, { result: ok[t.label] as Record<string, unknown> });
        } catch (err) {
          const msg = errorMessage(err);
          if (isAuthError(err)) authFailure = msg;
          errors.push(`${t.label}: ${msg}`);
          await onError(t, msg); // error isolation: other targets continue
          await log(job.id, 'error', `Failed ${t.label}: ${msg}`);
        } finally {
          done++;
          await heartbeat(job.id, (done / Math.max(1, targets.length)) * 100);
        }
      }),
    ),
  );
  if (authFailure) {
    await markGoogleRevoked(authFailure);
    await raiseNotification({
      type: 'oauth_problem',
      severity: 'critical',
      title: 'Google authorization problem',
      description: `Google rejected the stored credentials: ${authFailure}`,
      recommendedAction: 'Open Integrations and reconnect your Google account.',
      dedupeKey: `oauth:${todayIn('UTC')}`,
    });
  }
  if (errors.length && errors.length === targets.length) throw new Error(errors.join(' | '));
  return { status: errors.length ? 'partial' : 'success', result: { synced: Object.keys(ok).length, failed: errors.length, details: ok }, error: errors.join(' | ') || undefined };
}

async function requireGoogle() {
  const acct = await getActiveGoogleAccount();
  if (!acct) throw Object.assign(new Error('Google account is not connected'), { nonRetryable: true });
  if (acct.google_accounts.status === 'revoked') throw Object.assign(new Error('Google access revoked — reconnect required'), { nonRetryable: true });
}

export async function handleJob(job: Job): Promise<HandlerResult> {
  const settings = await getSettings();
  const s = settings.schedule;
  const today = todayIn(settings.general.timezone);
  const conc = s.concurrency;
  const params = job.params ?? {};

  switch (job.service) {
    case 'discovery': {
      const result: Record<string, unknown> = {};
      const errors: string[] = [];
      const google = await getActiveGoogleAccount();
      if (google && google.google_accounts.status === 'active') {
        const steps: Array<[string, () => Promise<unknown>]> = [
          ['search_console', discoverSearchConsoleProperties],
          ['ga4', discoverGa4Properties],
          ['admob', discoverAdmob],
        ];
        for (const [svc, fn] of steps) {
          try {
            result[svc] = await fn();
            await setServiceStatus(svc, 'connected', { success: true });
          } catch (err) {
            const msg = errorMessage(err);
            errors.push(`${svc}: ${msg}`);
            await setServiceStatus(svc, isAuthError(err) ? 'revoked' : 'error', { error: msg });
            if (isAuthError(err)) await markGoogleRevoked(msg);
          }
        }
        await ensureWebsitesForSelected();
      } else {
        result.google = 'not connected';
      }
      if (await getPlayServiceAccount()) {
        try {
          result.play_reporting = await discoverPlayApps();
        } catch (err) {
          errors.push(`play_reporting: ${errorMessage(err)}`);
        }
      } else {
        result.play_reporting = 'service account not configured';
      }
      return { status: errors.length ? 'partial' : 'success', result, error: errors.join(' | ') || undefined };
    }

    case 'search_console': {
      await requireGoogle();
      const where = job.targetId
        ? eq(searchConsoleProperties.id, job.targetId)
        : and(eq(searchConsoleProperties.isSelected, true), eq(searchConsoleProperties.isAccessible, true));
      const props = await db.select().from(searchConsoleProperties).where(where);
      const res = await runTargets(
        job,
        props.map((p) => ({ ...p, label: p.siteUrl })),
        conc,
        async (p) => {
          await db.update(searchConsoleProperties).set({ syncStatus: 'running' }).where(eq(searchConsoleProperties.id, p.id));
          return syncSearchConsoleProperty(p.id, syncWindow(p.lastDataDate, today, s.searchConsoleBackfillDays, Math.min(s.initialHistoryDays, 480), 0, params));
        },
        async (p, msg) => {
          await db.update(searchConsoleProperties).set({ syncStatus: 'failed', lastError: msg }).where(eq(searchConsoleProperties.id, p.id));
        },
      );
      await setServiceStatus('search_console', 'connected', { success: true });
      await enqueue('alerts', { params: { scope: 'search_console' } });
      return res;
    }

    case 'ga4': {
      await requireGoogle();
      const where = job.targetId ? eq(ga4Properties.id, job.targetId) : and(eq(ga4Properties.isSelected, true), eq(ga4Properties.isAccessible, true));
      const props = await db.select().from(ga4Properties).where(where);
      const res = await runTargets(
        job,
        props.map((p) => ({ ...p, label: p.displayName })),
        conc,
        async (p) => {
          await db.update(ga4Properties).set({ syncStatus: 'running' }).where(eq(ga4Properties.id, p.id));
          return syncGa4Property(p.id, syncWindow(p.lastDataDate, today, s.ga4BackfillDays, s.initialHistoryDays, 0, params));
        },
        async (p, msg) => {
          await db.update(ga4Properties).set({ syncStatus: 'failed', lastError: msg }).where(eq(ga4Properties.id, p.id));
        },
      );
      await setServiceStatus('ga4', 'connected', { success: true });
      await enqueue('alerts', { params: { scope: 'ga4' } });
      return res;
    }

    case 'admob': {
      await requireGoogle();
      const where = job.targetId ? eq(admobAccounts.id, job.targetId) : eq(admobAccounts.isSelected, true);
      const accts = await db.select().from(admobAccounts).where(where);
      const res = await runTargets(
        job,
        accts.map((a) => ({ ...a, label: a.publisherId })),
        1, // AdMob quotas are per account; keep sequential
        async (a) => {
          await db.update(admobAccounts).set({ syncStatus: 'running' }).where(eq(admobAccounts.id, a.id));
          const tz = a.reportingTimeZone ?? settings.general.timezone;
          return syncAdmobAccount(a.id, syncWindow(a.lastDataDate, todayIn(tz), s.admobBackfillDays, s.initialHistoryDays, 0, params));
        },
        async (a, msg) => {
          await db.update(admobAccounts).set({ syncStatus: 'failed', lastError: msg }).where(eq(admobAccounts.id, a.id));
        },
      );
      await setServiceStatus('admob', 'connected', { success: true });
      await enqueue('alerts', { params: { scope: 'admob' } });
      return res;
    }

    case 'play_reporting': {
      if (!(await getPlayServiceAccount())) throw Object.assign(new Error('Play service account not configured'), { nonRetryable: true });
      const where = job.targetId ? eq(playConsoleApps.id, job.targetId) : eq(playConsoleApps.isSelected, true);
      const apps = await db.select().from(playConsoleApps).where(where);
      const laToday = todayIn('America/Los_Angeles');
      const res = await runTargets(
        job,
        apps.map((a) => ({ ...a, label: a.packageName })),
        conc,
        async (a) => {
          // Respect data freshness: only request days Google has finished processing
          let end = addDays(laToday, -2);
          try {
            const fr = await playFreshness(a.id);
            const daily = fr?.freshnesses?.find((f) => f.aggregationPeriod === 'DAILY')?.latestEndTime;
            if (daily?.year && daily.month && daily.day) {
              end = addDays(`${daily.year}-${String(daily.month).padStart(2, '0')}-${String(daily.day).padStart(2, '0')}`, -1);
            }
          } catch {
            /* fall back to 2-day lag */
          }
          const lastDate = a.lastSyncedAt ? addDays(end, -s.playBackfillDays) : null;
          const window = params.start ? { start: String(params.start), end } : lastDate ? { start: lastDate, end } : { start: addDays(end, -(s.initialHistoryDays - 1)), end };
          return syncPlayApp(a.id, window);
        },
        async (a, msg) => {
          await db.update(playConsoleApps).set({ syncStatus: 'failed', lastError: msg }).where(eq(playConsoleApps.id, a.id));
        },
      );
      await setServiceStatus('play_reporting', 'connected', { success: true });
      await enqueue('alerts', { params: { scope: 'play_reporting' } });
      return res;
    }

    case 'alerts': {
      const created = await evaluateAlerts(String(params.scope ?? 'all'));
      return { status: 'success', result: { created } };
    }

    case 'ai_analysis': {
      const r = await runDailyAnalysis(typeof params.date === 'string' ? params.date : addDays(today, -1));
      return { status: 'success', result: r };
    }

    case 'daily_report': {
      const date = typeof params.date === 'string' ? params.date : addDays(today, -1);
      if (settings.ai.enabled && settings.ai.dailyAnalysis) {
        try {
          await runDailyAnalysis(date);
        } catch (err) {
          logger.warn({ err: errorMessage(err) }, 'AI analysis skipped for daily report');
        }
      }
      const r = await generateDailyReport(date, { email: params.email !== false });
      // weekly (Monday) and monthly (1st) summaries
      const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
      if (weekday === 1 && settings.email.weekly) await sendSummaryEmail('weekly', date).catch(() => undefined);
      if (today.endsWith('-01') && settings.email.monthly) await sendSummaryEmail('monthly', date).catch(() => undefined);
      return { status: 'success', result: r };
    }

    case 'summary_email': {
      const kind = params.kind === 'monthly' ? 'monthly' : 'weekly';
      const r = await sendSummaryEmail(kind, addDays(today, -1));
      return { status: 'success', result: r };
    }

    default:
      throw Object.assign(new Error(`Unknown job service ${job.service}`), { nonRetryable: true });
  }
}
