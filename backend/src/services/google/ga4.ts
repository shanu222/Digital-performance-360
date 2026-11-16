import { google, type analyticsdata_v1beta, type analyticsadmin_v1beta } from 'googleapis';
import { eq, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { ga4Properties, analyticsDailyMetrics } from '../../db/schema.js';
import { getAuthedClient } from './oauth.js';
import { withRetry } from '../../lib/retry.js';
import { chunk, ga4Date, num } from '../../lib/util.js';
import { notFound } from '../../lib/http.js';
import { upsertBreakdown } from './searchConsole.js';
import { errorMessage } from '../../lib/logger.js';

export async function dataClient(): Promise<analyticsdata_v1beta.Analyticsdata> {
  return google.analyticsdata({ version: 'v1beta', auth: await getAuthedClient() });
}
export async function adminClient(): Promise<analyticsadmin_v1beta.Analyticsadmin> {
  return google.analyticsadmin({ version: 'v1beta', auth: await getAuthedClient() });
}

/** Analytics Admin API: account summaries list every GA4 property the user can read. */
export async function discoverGa4Properties(client?: analyticsadmin_v1beta.Analyticsadmin) {
  const admin = client ?? (await adminClient());
  const found: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await withRetry(() => admin.accountSummaries.list({ pageSize: 200, pageToken }), { label: 'ga4.accountSummaries' });
    for (const acct of res.data.accountSummaries ?? []) {
      for (const p of acct.propertySummaries ?? []) {
        if (!p.property) continue;
        found.push(p.property);
        await db
          .insert(ga4Properties)
          .values({
            propertyName: p.property,
            displayName: p.displayName ?? p.property,
            accountName: acct.account ?? null,
            accountDisplayName: acct.displayName ?? null,
            propertyType: p.propertyType ?? null,
            source: 'discovered',
          })
          .onConflictDoUpdate({
            target: ga4Properties.propertyName,
            set: {
              displayName: p.displayName ?? p.property,
              accountName: acct.account ?? null,
              accountDisplayName: acct.displayName ?? null,
              propertyType: p.propertyType ?? null,
              isAccessible: true,
              updatedAt: new Date(),
            },
          });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  if (found.length) {
    await db
      .update(ga4Properties)
      .set({ isAccessible: false, updatedAt: new Date() })
      .where(notInArray(ga4Properties.propertyName, found));
  }
  return found.length;
}

/** Fetch time zone + currency (needed to interpret dates and revenue). */
export async function refreshGa4PropertyDetails(propertyId: string, client?: analyticsadmin_v1beta.Analyticsadmin) {
  const [prop] = await db.select().from(ga4Properties).where(eq(ga4Properties.id, propertyId));
  if (!prop) throw notFound('GA4 property');
  const admin = client ?? (await adminClient());
  const res = await withRetry(() => admin.properties.get({ name: prop.propertyName }));
  await db
    .update(ga4Properties)
    .set({ timeZone: res.data.timeZone ?? null, currencyCode: res.data.currencyCode ?? null, updatedAt: new Date() })
    .where(eq(ga4Properties.id, propertyId));
  return res.data;
}

type Report = analyticsdata_v1beta.Schema$RunReportResponse;

async function runReportAll(
  api: analyticsdata_v1beta.Analyticsdata,
  property: string,
  body: analyticsdata_v1beta.Schema$RunReportRequest,
  maxRows = 50_000,
): Promise<Report & { allRows: analyticsdata_v1beta.Schema$Row[] }> {
  const allRows: analyticsdata_v1beta.Schema$Row[] = [];
  let offset = 0;
  const limit = 10_000;
  let first: Report | undefined;
  while (allRows.length < maxRows) {
    const res = await withRetry(
      () => api.properties.runReport({ property, requestBody: { ...body, limit: String(limit), offset: String(offset) } }),
      { label: 'ga4.runReport' },
    );
    first ??= res.data;
    const rows = res.data.rows ?? [];
    allRows.push(...rows);
    const total = res.data.rowCount ?? 0;
    offset += limit;
    if (!rows.length || offset >= total) break;
  }
  return { ...(first ?? {}), allRows };
}

/** Map a GA4 row to {dimensionName: value, metricName: number|null} using the response headers. */
export function mapRows(report: Report, rows: analyticsdata_v1beta.Schema$Row[]) {
  const dims = (report.dimensionHeaders ?? []).map((d) => d.name!);
  const mets = (report.metricHeaders ?? []).map((m) => m.name!);
  return rows.map((r) => {
    const o: Record<string, string | number | null> = {};
    dims.forEach((d, i) => (o[d] = r.dimensionValues?.[i]?.value ?? ''));
    mets.forEach((m, i) => (o[m] = num(r.metricValues?.[i]?.value)));
    return o;
  });
}

const CORE_METRICS = [
  'activeUsers',
  'newUsers',
  'totalUsers',
  'sessions',
  'engagedSessions',
  'engagementRate',
  'userEngagementDuration',
  'screenPageViews',
  'eventCount',
  'keyEvents',
];

/** keyEvents replaced conversions in 2024; fall back for properties/APIs that reject it. */
async function runWithKeyEventFallback(
  api: analyticsdata_v1beta.Analyticsdata,
  property: string,
  body: analyticsdata_v1beta.Schema$RunReportRequest,
  maxRows?: number,
) {
  try {
    return await runReportAll(api, property, body, maxRows);
  } catch (err) {
    if (!/keyEvents/i.test(errorMessage(err))) throw err;
    const metrics = (body.metrics ?? []).map((m) => (m.name === 'keyEvents' ? { name: 'conversions' } : m));
    const res = await runReportAll(api, property, { ...body, metrics }, maxRows);
    res.metricHeaders = res.metricHeaders?.map((h) => (h.name === 'conversions' ? { ...h, name: 'keyEvents' } : h));
    return res;
  }
}

export async function syncGa4Property(
  propertyId: string,
  range: { start: string; end: string },
  opts: { client?: analyticsdata_v1beta.Analyticsdata; admin?: analyticsadmin_v1beta.Analyticsadmin } = {},
) {
  let [prop] = await db.select().from(ga4Properties).where(eq(ga4Properties.id, propertyId));
  if (!prop) throw notFound('GA4 property');
  if (!prop.timeZone || !prop.currencyCode) {
    try {
      await refreshGa4PropertyDetails(prop.id, opts.admin);
      [prop] = await db.select().from(ga4Properties).where(eq(ga4Properties.id, propertyId));
    } catch {
      /* details are optional; continue */
    }
  }
  const api = opts.client ?? (await dataClient());
  const dateRanges = [{ startDate: range.start, endDate: range.end }];
  const now = new Date();

  // Core daily metrics (GA4 allows max 10 metrics per request)
  const core = await runWithKeyEventFallback(api, prop.propertyName, {
    dateRanges,
    dimensions: [{ name: 'date' }],
    metrics: CORE_METRICS.map((name) => ({ name })),
    keepEmptyRows: true,
  });
  const coreRows = mapRows(core, core.allRows);

  // Revenue only when configured — a separate request so its absence does not break core metrics
  const revenueByDate = new Map<string, number | null>();
  try {
    const rev = await runReportAll(api, prop.propertyName, { dateRanges, dimensions: [{ name: 'date' }], metrics: [{ name: 'totalRevenue' }] });
    for (const r of mapRows(rev, rev.allRows)) revenueByDate.set(ga4Date(String(r.date)), r.totalRevenue as number | null);
  } catch {
    /* revenue not available for this property */
  }

  for (const part of chunk(coreRows, 500)) {
    await db
      .insert(analyticsDailyMetrics)
      .values(
        part.map((r) => {
          const d = ga4Date(String(r.date));
          return {
            ga4PropertyId: prop.id,
            metricDate: d,
            activeUsers: r.activeUsers as number | null,
            newUsers: r.newUsers as number | null,
            totalUsers: r.totalUsers as number | null,
            sessions: r.sessions as number | null,
            engagedSessions: r.engagedSessions as number | null,
            engagementRate: r.engagementRate as number | null,
            userEngagementDuration: r.userEngagementDuration as number | null,
            screenPageViews: r.screenPageViews as number | null,
            eventCount: r.eventCount as number | null,
            keyEvents: r.keyEvents as number | null,
            totalRevenue: revenueByDate.has(d) ? revenueByDate.get(d)! : null,
            currency: prop.currencyCode,
            retrievedAt: now,
          };
        }),
      )
      .onConflictDoUpdate({
        target: [analyticsDailyMetrics.ga4PropertyId, analyticsDailyMetrics.metricDate],
        set: {
          activeUsers: sql`excluded.active_users`,
          newUsers: sql`excluded.new_users`,
          totalUsers: sql`excluded.total_users`,
          sessions: sql`excluded.sessions`,
          engagedSessions: sql`excluded.engaged_sessions`,
          engagementRate: sql`excluded.engagement_rate`,
          userEngagementDuration: sql`excluded.user_engagement_duration`,
          screenPageViews: sql`excluded.screen_page_views`,
          eventCount: sql`excluded.event_count`,
          keyEvents: sql`excluded.key_events`,
          totalRevenue: sql`excluded.total_revenue`,
          currency: sql`excluded.currency`,
          retrievedAt: sql`excluded.retrieved_at`,
        },
      });
  }

  // Breakdowns
  const breakdowns: Array<{ dim: string; ga4Dim: string; metrics: string[]; max: number }> = [
    { dim: 'country', ga4Dim: 'country', metrics: ['activeUsers', 'newUsers', 'sessions', 'engagedSessions', 'keyEvents'], max: 50_000 },
    { dim: 'device', ga4Dim: 'deviceCategory', metrics: ['activeUsers', 'newUsers', 'sessions', 'engagedSessions', 'keyEvents'], max: 10_000 },
    { dim: 'channel', ga4Dim: 'sessionDefaultChannelGroup', metrics: ['activeUsers', 'newUsers', 'sessions', 'engagedSessions', 'keyEvents'], max: 10_000 },
    { dim: 'page', ga4Dim: 'pagePath', metrics: ['activeUsers', 'screenPageViews', 'sessions', 'engagedSessions', 'keyEvents'], max: 60_000 },
  ];
  let breakdownRows = 0;
  for (const b of breakdowns) {
    const rep = await runWithKeyEventFallback(
      api,
      prop.propertyName,
      { dateRanges, dimensions: [{ name: 'date' }, { name: b.ga4Dim }], metrics: b.metrics.map((name) => ({ name })) },
      b.max,
    );
    const rows = mapRows(rep, rep.allRows);
    breakdownRows += rows.length;
    for (const part of chunk(rows, 1000)) {
      await upsertBreakdown(
        part.map((r) => ({
          source: 'ga4',
          propertyId: prop.id,
          metricDate: ga4Date(String(r.date)),
          dimension: b.dim,
          dimensionValue: String(r[b.ga4Dim] || '(not set)'),
          activeUsers: r.activeUsers as number | null,
          newUsers: (r.newUsers as number | null) ?? null,
          sessions: r.sessions as number | null,
          engagedSessions: r.engagedSessions as number | null,
          screenPageViews: (r.screenPageViews as number | null) ?? null,
          keyEvents: r.keyEvents as number | null,
          retrievedAt: now,
        })),
      );
    }
  }

  const lastDataDate = coreRows.reduce<string | null>((m, r) => {
    const d = ga4Date(String(r.date));
    return !m || d > m ? d : m;
  }, prop.lastDataDate);
  await db
    .update(ga4Properties)
    .set({ lastSyncedAt: now, lastDataDate, syncStatus: 'success', lastError: null, updatedAt: now })
    .where(eq(ga4Properties.id, prop.id));
  return { days: coreRows.length, breakdownRows, lastDataDate };
}

/* ---------------- live queries (cached briefly) ---------------- */

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Users are not additive across days, so range totals for users come from a live
 * GA4 query over the whole range (deduplicated by Google), cached for 15 minutes.
 */
export async function ga4RangeTotals(propertyId: string, range: { start: string; end: string }) {
  const [prop] = await db.select().from(ga4Properties).where(eq(ga4Properties.id, propertyId));
  if (!prop) throw notFound('GA4 property');
  return cached(`range:${prop.id}:${range.start}:${range.end}`, 15 * 60_000, async () => {
    const api = await dataClient();
    const rep = await runWithKeyEventFallback(api, prop.propertyName, {
      dateRanges: [{ startDate: range.start, endDate: range.end }],
      metrics: ['activeUsers', 'newUsers', 'totalUsers', 'sessions', 'engagedSessions', 'engagementRate', 'userEngagementDuration', 'screenPageViews', 'eventCount', 'keyEvents'].map(
        (name) => ({ name }),
      ),
    });
    const [row] = mapRows(rep, rep.allRows);
    return row ?? null;
  });
}

/** Realtime API: last 30 minutes. Traffic source dimensions are not offered by the Realtime API. */
export async function ga4Realtime(propertyId: string) {
  const [prop] = await db.select().from(ga4Properties).where(eq(ga4Properties.id, propertyId));
  if (!prop) throw notFound('GA4 property');
  return cached(`rt:${prop.id}`, 60_000, async () => {
    const api = await dataClient();
    const run = (dimensions: string[], limit = 10) =>
      withRetry(() =>
        api.properties.runRealtimeReport({
          property: prop.propertyName,
          requestBody: {
            dimensions: dimensions.map((name) => ({ name })),
            metrics: [{ name: 'activeUsers' }],
            limit: String(limit),
            orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
          },
        }),
      );
    const [total, countries, pages, platforms] = await Promise.all([run([]), run(['country']), run(['unifiedScreenName']), run(['platform'])]);
    const val = (r: analyticsdata_v1beta.Schema$RunRealtimeReportResponse) =>
      (r.rows ?? []).map((row) => ({ name: row.dimensionValues?.[0]?.value ?? '', activeUsers: num(row.metricValues?.[0]?.value) ?? 0 }));
    return {
      activeUsers30m: total.data.rows?.length ? num(total.data.rows[0].metricValues?.[0]?.value) : 0,
      topCountries: val(countries.data),
      topPages: val(pages.data),
      platforms: val(platforms.data),
      trafficSources: null as null, // not available via the Realtime API
      fetchedAt: new Date().toISOString(),
    };
  });
}
