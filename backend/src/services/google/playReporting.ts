import { google, type playdeveloperreporting_v1beta1 } from 'googleapis';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { playConsoleApps, appVitals, androidApps } from '../../db/schema.js';
import { getPlayAuth, setServiceStatus } from './oauth.js';
import { withRetry } from '../../lib/retry.js';
import { chunk } from '../../lib/util.js';
import { toYmdParts, addDays } from '../../lib/dates.js';
import { notFound } from '../../lib/http.js';
import { errorMessage } from '../../lib/logger.js';

type Api = playdeveloperreporting_v1beta1.Playdeveloperreporting;

export async function playClient(): Promise<Api> {
  return google.playdeveloperreporting({ version: 'v1beta1', auth: await getPlayAuth() });
}

/**
 * Metric sets queried. Names are taken from the official v1beta1 reference.
 * Daily aggregation requires the America/Los_Angeles time zone.
 */
export const VITAL_SETS = [
  { key: 'crashRate', resource: 'crashrate', set: 'crashRateMetricSet', metrics: ['crashRate', 'userPerceivedCrashRate', 'distinctUsers'] },
  { key: 'anrRate', resource: 'anrrate', set: 'anrRateMetricSet', metrics: ['anrRate', 'userPerceivedAnrRate', 'distinctUsers'] },
  { key: 'slowStartRate', resource: 'slowstartrate', set: 'slowStartRateMetricSet', metrics: ['slowStartRate', 'distinctUsers'], dimensions: ['startType'] },
  {
    key: 'slowRenderingRate',
    resource: 'slowrenderingrate',
    set: 'slowRenderingRateMetricSet',
    metrics: ['slowRenderingRate20Fps', 'slowRenderingRate30Fps', 'distinctUsers'],
  },
  { key: 'excessiveWakeupRate', resource: 'excessivewakeuprate', set: 'excessiveWakeupRateMetricSet', metrics: ['excessiveWakeupRate', 'distinctUsers'] },
  {
    key: 'stuckBackgroundWakelockRate',
    resource: 'stuckbackgroundwakelockrate',
    set: 'stuckBackgroundWakelockRateMetricSet',
    metrics: ['stuckBgWakelockRate', 'distinctUsers'],
  },
  { key: 'errorCount', resource: 'errors.counts', set: 'errorCountMetricSet', metrics: ['errorReportCount', 'distinctUsers'] },
] as const;

/** Rate metrics are returned as fractions (0.0123) – stored as percentages for display. */
const RATE_METRICS = new Set([
  'crashRate',
  'userPerceivedCrashRate',
  'anrRate',
  'userPerceivedAnrRate',
  'slowStartRate',
  'slowRenderingRate20Fps',
  'slowRenderingRate30Fps',
  'excessiveWakeupRate',
  'stuckBgWakelockRate',
]);

export async function discoverPlayApps(client?: Api) {
  const api = client ?? (await playClient());
  let pageToken: string | undefined;
  let count = 0;
  try {
    do {
      const res = await withRetry(() => api.apps.search({ pageSize: 1000, pageToken }), { label: 'play.apps.search' });
      for (const app of res.data.apps ?? []) {
        if (!app.packageName || !app.name) continue;
        count++;
        const [row] = await db
          .insert(playConsoleApps)
          .values({ resourceName: app.name, packageName: app.packageName, displayName: app.displayName ?? app.packageName })
          .onConflictDoUpdate({
            target: playConsoleApps.packageName,
            set: { displayName: app.displayName ?? app.packageName, resourceName: app.name, updatedAt: new Date() },
          })
          .returning();
        await db
          .insert(androidApps)
          .values({ name: app.displayName ?? app.packageName, packageName: app.packageName, playConsoleAppId: row.id, source: 'discovered' })
          .onConflictDoUpdate({ target: androidApps.packageName, set: { playConsoleAppId: row.id, updatedAt: new Date() } });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    await setServiceStatus('play_reporting', 'connected', { success: true });
  } catch (err) {
    await setServiceStatus('play_reporting', 'error', { error: errorMessage(err) });
    throw err;
  }
  return count;
}

function resourceFor(api: Api, resource: string) {
  const v = api.vitals as unknown as Record<string, { query: (p: unknown) => Promise<{ data: playdeveloperreporting_v1beta1.Schema$GooglePlayDeveloperReportingV1beta1QueryCrashRateMetricSetResponse }> }>;
  if (resource === 'errors.counts') return (api.vitals.errors.counts as unknown) as { query: (p: unknown) => Promise<{ data: playdeveloperreporting_v1beta1.Schema$GooglePlayDeveloperReportingV1beta1QueryCrashRateMetricSetResponse }> };
  return v[resource];
}

function decimalValue(m: playdeveloperreporting_v1beta1.Schema$GooglePlayDeveloperReportingV1beta1MetricValue) {
  const raw = m.decimalValue?.value;
  return raw != null ? Number(raw) : null;
}

export async function syncPlayApp(appId: string, range: { start: string; end: string }, client?: Api) {
  const [app] = await db.select().from(playConsoleApps).where(eq(playConsoleApps.id, appId));
  if (!app) throw notFound('Play app');
  const api = client ?? (await playClient());
  const now = new Date();
  const results: Record<string, number | string> = {};
  const failures: string[] = [];

  for (const vs of VITAL_SETS) {
    try {
      const res = await withRetry(
        () =>
          resourceFor(api, vs.resource).query({
            name: `${app.resourceName}/${vs.set}`,
            requestBody: {
              timelineSpec: {
                aggregationPeriod: 'DAILY',
                startTime: { ...toYmdParts(range.start), timeZone: { id: 'America/Los_Angeles' } },
                // end is exclusive
                endTime: { ...toYmdParts(addDays(range.end, 1)), timeZone: { id: 'America/Los_Angeles' } },
              },
              metrics: [...vs.metrics],
              ...('dimensions' in vs ? { dimensions: [...vs.dimensions] } : {}),
              pageSize: 10000,
            },
          }),
        { label: `play.${vs.key}` },
      );
      const rows = res.data.rows ?? [];
      const values: Array<typeof appVitals.$inferInsert> = [];
      for (const r of rows) {
        const st = r.startTime;
        if (!st?.year || !st.month || !st.day) continue;
        const date = `${st.year}-${String(st.month).padStart(2, '0')}-${String(st.day).padStart(2, '0')}`;
        const slice = (r.dimensions ?? []).map((d) => `${d.dimension}=${d.stringValue ?? d.int64Value ?? ''}`).join('|');
        for (const m of r.metrics ?? []) {
          if (!m.metric) continue;
          const v = decimalValue(m);
          values.push({
            playConsoleAppId: app.id,
            metricDate: date,
            metricSet: vs.key,
            metric: m.metric,
            slice,
            value: v == null ? null : RATE_METRICS.has(m.metric) ? v * 100 : v,
            retrievedAt: now,
          });
        }
      }
      for (const part of chunk(values, 1000)) {
        await db
          .insert(appVitals)
          .values(part)
          .onConflictDoUpdate({
            target: [appVitals.playConsoleAppId, appVitals.metricDate, appVitals.metricSet, appVitals.metric, appVitals.slice],
            set: { value: sql`excluded.value`, retrievedAt: sql`excluded.retrieved_at` },
          });
      }
      results[vs.key] = values.length;
    } catch (err) {
      // Some metric sets are unavailable for small apps — record and continue (error isolation)
      failures.push(`${vs.key}: ${errorMessage(err)}`);
      results[vs.key] = 'unavailable';
    }
  }

  // Crash and ANR are the core vitals; the other sets are often unavailable for
  // apps below Google's minimum-user thresholds, which is normal, not a failure.
  const coreFailed = failures.filter((f) => f.startsWith('crashRate') || f.startsWith('anrRate'));
  await db
    .update(playConsoleApps)
    .set({
      lastSyncedAt: now,
      syncStatus: failures.length === VITAL_SETS.length ? 'failed' : coreFailed.length ? 'partial' : 'success',
      lastError: coreFailed.length ? coreFailed.join(' | ').slice(0, 2000) : null,
      updatedAt: now,
    })
    .where(eq(playConsoleApps.id, app.id));
  if (failures.length === VITAL_SETS.length) throw new Error(failures[0]);
  return { results, failures };
}

/** Freshness: latest available end time for crash-rate data (Play data typically lags ~1-2 days). */
export async function playFreshness(appId: string) {
  const [app] = await db.select().from(playConsoleApps).where(eq(playConsoleApps.id, appId));
  if (!app) throw notFound('Play app');
  const api = await playClient();
  const res = await api.vitals.crashrate.get({ name: `${app.resourceName}/crashRateMetricSet` });
  await db.update(playConsoleApps).set({ freshness: res.data.freshnessInfo as Record<string, unknown> }).where(eq(playConsoleApps.id, app.id));
  return res.data.freshnessInfo;
}
