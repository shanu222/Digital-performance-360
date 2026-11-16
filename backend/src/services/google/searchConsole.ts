import { google, type searchconsole_v1 } from 'googleapis';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  searchConsoleProperties,
  websiteDailyMetrics,
  keywordDailyMetrics,
  pageDailyMetrics,
  countryDailyMetrics,
  sitemapRecords,
  urlInspections,
  websites,
} from '../../db/schema.js';
import { getAuthedClient } from './oauth.js';
import { withRetry } from '../../lib/retry.js';
import { chunk } from '../../lib/util.js';
import { notFound } from '../../lib/http.js';

export async function scClient(): Promise<searchconsole_v1.Searchconsole> {
  return google.searchconsole({ version: 'v1', auth: await getAuthedClient() });
}

export function propertyTypeOf(siteUrl: string) {
  return siteUrl.startsWith('sc-domain:') ? 'domain' : 'url_prefix';
}

export function domainOf(siteUrl: string) {
  if (siteUrl.startsWith('sc-domain:')) return siteUrl.slice('sc-domain:'.length);
  try {
    return new URL(siteUrl).hostname.replace(/^www\./, '');
  } catch {
    return siteUrl;
  }
}

/** Sites API: discover every property the connected account can access. */
export async function discoverSearchConsoleProperties(client?: searchconsole_v1.Searchconsole) {
  const sc = client ?? (await scClient());
  const res = await withRetry(() => sc.sites.list(), { label: 'sc.sites.list' });
  const entries = (res.data.siteEntry ?? []).filter((s) => s.siteUrl);
  const urls: string[] = [];
  for (const s of entries) {
    urls.push(s.siteUrl!);
    await db
      .insert(searchConsoleProperties)
      .values({
        siteUrl: s.siteUrl!,
        propertyType: propertyTypeOf(s.siteUrl!),
        permissionLevel: s.permissionLevel ?? null,
        isAccessible: s.permissionLevel !== 'siteUnverifiedUser',
      })
      .onConflictDoUpdate({
        target: searchConsoleProperties.siteUrl,
        set: {
          permissionLevel: s.permissionLevel ?? null,
          isAccessible: s.permissionLevel !== 'siteUnverifiedUser',
          updatedAt: new Date(),
        },
      });
  }
  // Properties no longer returned by Google lose access but keep their history.
  if (urls.length) {
    await db
      .update(searchConsoleProperties)
      .set({ isAccessible: false, updatedAt: new Date() })
      .where(notInArray(searchConsoleProperties.siteUrl, urls));
  }
  return entries.length;
}

type Row = searchconsole_v1.Schema$ApiDataRow;

/** Paginates searchanalytics.query (max 25,000 rows per request). */
async function queryAll(
  sc: searchconsole_v1.Searchconsole,
  siteUrl: string,
  body: searchconsole_v1.Schema$SearchAnalyticsQueryRequest,
  maxRows = 100_000,
): Promise<{ rows: Row[]; firstIncompleteDate?: string | null }> {
  const rows: Row[] = [];
  let startRow = 0;
  let firstIncompleteDate: string | null | undefined;
  const rowLimit = 25_000;
  while (rows.length < maxRows) {
    const res = await withRetry(
      () => sc.searchanalytics.query({ siteUrl, requestBody: { ...body, rowLimit, startRow } }),
      { label: 'sc.searchanalytics.query' },
    );
    const batch = res.data.rows ?? [];
    firstIncompleteDate ??= (res.data as { metadata?: { firstIncompleteDate?: string } }).metadata?.firstIncompleteDate;
    rows.push(...batch);
    if (batch.length < rowLimit) break;
    startRow += rowLimit;
  }
  return { rows, firstIncompleteDate };
}

const stateFor = (date: string, firstIncomplete?: string | null) =>
  firstIncomplete && date >= firstIncomplete ? 'fresh' : 'final';

export interface ScSyncResult {
  days: number;
  keywords: number;
  pages: number;
  breakdownRows: number;
  sitemaps: number;
  lastDataDate: string | null;
}

/**
 * Incremental sync for one property: daily totals, date×query, date×page,
 * date×country, date×device, and sitemaps. Uses dataState=all so preliminary
 * ("fresh") days are stored but labelled, then overwritten when final.
 */
export async function syncSearchConsoleProperty(
  propertyId: string,
  range: { start: string; end: string },
  opts: { client?: searchconsole_v1.Searchconsole; maxKeywordRows?: number } = {},
): Promise<ScSyncResult> {
  const [prop] = await db.select().from(searchConsoleProperties).where(eq(searchConsoleProperties.id, propertyId));
  if (!prop) throw notFound('Search Console property');
  const sc = opts.client ?? (await scClient());
  const base = { startDate: range.start, endDate: range.end, dataState: 'all', type: 'web' };
  const now = new Date();

  // 1) Daily totals
  const totals = await queryAll(sc, prop.siteUrl, { ...base, dimensions: ['date'] });
  const fid = totals.firstIncompleteDate;
  for (const part of chunk(totals.rows, 500)) {
    await db
      .insert(websiteDailyMetrics)
      .values(
        part.map((r) => ({
          searchConsolePropertyId: prop.id,
          metricDate: r.keys![0],
          clicks: Math.round(r.clicks ?? 0),
          impressions: Math.round(r.impressions ?? 0),
          ctr: r.ctr ?? 0,
          position: r.position ?? 0,
          dataState: stateFor(r.keys![0], fid),
          retrievedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [websiteDailyMetrics.searchConsolePropertyId, websiteDailyMetrics.metricDate],
        set: {
          clicks: sql`excluded.clicks`,
          impressions: sql`excluded.impressions`,
          ctr: sql`excluded.ctr`,
          position: sql`excluded.position`,
          dataState: sql`excluded.data_state`,
          retrievedAt: sql`excluded.retrieved_at`,
        },
      });
  }

  // 2) Keywords (date × query)
  const kw = await queryAll(sc, prop.siteUrl, { ...base, dimensions: ['date', 'query'] }, opts.maxKeywordRows ?? 150_000);
  for (const part of chunk(kw.rows, 1000)) {
    await db
      .insert(keywordDailyMetrics)
      .values(
        part.map((r) => ({
          searchConsolePropertyId: prop.id,
          metricDate: r.keys![0],
          query: r.keys![1],
          clicks: Math.round(r.clicks ?? 0),
          impressions: Math.round(r.impressions ?? 0),
          ctr: r.ctr ?? 0,
          position: r.position ?? 0,
          dataState: stateFor(r.keys![0], fid),
          retrievedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [keywordDailyMetrics.searchConsolePropertyId, keywordDailyMetrics.metricDate, keywordDailyMetrics.query],
        set: {
          clicks: sql`excluded.clicks`,
          impressions: sql`excluded.impressions`,
          ctr: sql`excluded.ctr`,
          position: sql`excluded.position`,
          dataState: sql`excluded.data_state`,
          retrievedAt: sql`excluded.retrieved_at`,
        },
      });
  }

  // 3) Pages (date × page)
  const pg = await queryAll(sc, prop.siteUrl, { ...base, dimensions: ['date', 'page'] }, 100_000);
  for (const part of chunk(pg.rows, 1000)) {
    await db
      .insert(pageDailyMetrics)
      .values(
        part.map((r) => ({
          searchConsolePropertyId: prop.id,
          metricDate: r.keys![0],
          page: r.keys![1],
          clicks: Math.round(r.clicks ?? 0),
          impressions: Math.round(r.impressions ?? 0),
          ctr: r.ctr ?? 0,
          position: r.position ?? 0,
          dataState: stateFor(r.keys![0], fid),
          retrievedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [pageDailyMetrics.searchConsolePropertyId, pageDailyMetrics.metricDate, pageDailyMetrics.page],
        set: {
          clicks: sql`excluded.clicks`,
          impressions: sql`excluded.impressions`,
          ctr: sql`excluded.ctr`,
          position: sql`excluded.position`,
          dataState: sql`excluded.data_state`,
          retrievedAt: sql`excluded.retrieved_at`,
        },
      });
  }

  // 4) Country & device breakdowns
  let breakdownRows = 0;
  for (const dim of ['country', 'device'] as const) {
    const res = await queryAll(sc, prop.siteUrl, { ...base, dimensions: ['date', dim] }, 50_000);
    breakdownRows += res.rows.length;
    for (const part of chunk(res.rows, 1000)) {
      await upsertBreakdown(
        part.map((r) => ({
          source: 'search_console',
          propertyId: prop.id,
          metricDate: r.keys![0],
          dimension: dim,
          dimensionValue: r.keys![1],
          clicks: Math.round(r.clicks ?? 0),
          impressions: Math.round(r.impressions ?? 0),
          ctr: r.ctr ?? 0,
          position: r.position ?? 0,
          retrievedAt: now,
        })),
      );
    }
  }

  // 5) Sitemaps
  const sitemaps = await syncSitemaps(prop.id, prop.siteUrl, sc);

  const lastDataDate = totals.rows.reduce<string | null>((m, r) => (!m || r.keys![0] > m ? r.keys![0] : m), prop.lastDataDate);
  await db
    .update(searchConsoleProperties)
    .set({ lastSyncedAt: now, lastDataDate, syncStatus: 'success', lastError: null, updatedAt: now })
    .where(eq(searchConsoleProperties.id, prop.id));

  return { days: totals.rows.length, keywords: kw.rows.length, pages: pg.rows.length, breakdownRows, sitemaps, lastDataDate };
}

export async function upsertBreakdown(rows: Array<typeof countryDailyMetrics.$inferInsert>) {
  if (!rows.length) return;
  await db
    .insert(countryDailyMetrics)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        countryDailyMetrics.source,
        countryDailyMetrics.propertyId,
        countryDailyMetrics.metricDate,
        countryDailyMetrics.dimension,
        countryDailyMetrics.dimensionValue,
      ],
      set: {
        clicks: sql`excluded.clicks`,
        impressions: sql`excluded.impressions`,
        ctr: sql`excluded.ctr`,
        position: sql`excluded.position`,
        activeUsers: sql`excluded.active_users`,
        newUsers: sql`excluded.new_users`,
        sessions: sql`excluded.sessions`,
        engagedSessions: sql`excluded.engaged_sessions`,
        screenPageViews: sql`excluded.screen_page_views`,
        keyEvents: sql`excluded.key_events`,
        retrievedAt: sql`excluded.retrieved_at`,
      },
    });
}

export async function syncSitemaps(propertyId: string, siteUrl: string, sc: searchconsole_v1.Searchconsole) {
  const res = await withRetry(() => sc.sitemaps.list({ siteUrl }), { label: 'sc.sitemaps.list' });
  const list = res.data.sitemap ?? [];
  const now = new Date();
  for (const s of list) {
    if (!s.path) continue;
    const values = {
      searchConsolePropertyId: propertyId,
      path: s.path,
      type: s.type ?? null,
      isPending: s.isPending ?? null,
      isSitemapsIndex: s.isSitemapsIndex ?? null,
      lastSubmitted: s.lastSubmitted ? new Date(s.lastSubmitted) : null,
      lastDownloaded: s.lastDownloaded ? new Date(s.lastDownloaded) : null,
      warnings: s.warnings != null ? Number(s.warnings) : null,
      errors: s.errors != null ? Number(s.errors) : null,
      contents: (s.contents ?? []).map((c) => ({ type: c.type, submitted: c.submitted, indexed: c.indexed })),
      retrievedAt: now,
    };
    await db
      .insert(sitemapRecords)
      .values(values)
      .onConflictDoUpdate({ target: [sitemapRecords.searchConsolePropertyId, sitemapRecords.path], set: values });
  }
  const paths = list.map((s) => s.path!).filter(Boolean);
  // remove sitemaps that were deleted in Search Console
  if (paths.length) {
    await db
      .delete(sitemapRecords)
      .where(and(eq(sitemapRecords.searchConsolePropertyId, propertyId), notInArray(sitemapRecords.path, paths)));
  } else {
    await db.delete(sitemapRecords).where(eq(sitemapRecords.searchConsolePropertyId, propertyId));
  }
  return list.length;
}

/**
 * URL Inspection API — inspects ONE URL at a time (quota ~2,000/day/property).
 * This is not a bulk index database; aggregated coverage lives in the Search Console UI.
 */
export async function inspectUrl(propertyId: string, url: string, client?: searchconsole_v1.Searchconsole) {
  const [prop] = await db.select().from(searchConsoleProperties).where(eq(searchConsoleProperties.id, propertyId));
  if (!prop) throw notFound('Search Console property');
  const sc = client ?? (await scClient());
  const res = await withRetry(
    () => sc.urlInspection.index.inspect({ requestBody: { inspectionUrl: url, siteUrl: prop.siteUrl, languageCode: 'en-US' } }),
    { label: 'sc.urlInspection', retries: 2 },
  );
  const r = res.data.inspectionResult ?? {};
  const idx = r.indexStatusResult ?? {};
  const [row] = await db
    .insert(urlInspections)
    .values({
      searchConsolePropertyId: prop.id,
      url,
      verdict: idx.verdict ?? null,
      coverageState: idx.coverageState ?? null,
      robotsTxtState: idx.robotsTxtState ?? null,
      indexingState: idx.indexingState ?? null,
      pageFetchState: idx.pageFetchState ?? null,
      googleCanonical: idx.googleCanonical ?? null,
      userCanonical: idx.userCanonical ?? null,
      lastCrawlTime: idx.lastCrawlTime ? new Date(idx.lastCrawlTime) : null,
      crawledAs: idx.crawledAs ?? null,
      mobileUsabilityVerdict: r.mobileUsabilityResult?.verdict ?? null,
      inspectionResultLink: r.inspectionResultLink ?? null,
      raw: r as unknown as Record<string, unknown>,
    })
    .returning();
  return row;
}

/** Live (not stored) search-appearance breakdown — this dimension cannot be combined with date. */
export async function liveSearchAppearance(propertyId: string, range: { start: string; end: string }) {
  const [prop] = await db.select().from(searchConsoleProperties).where(eq(searchConsoleProperties.id, propertyId));
  if (!prop) throw notFound('Search Console property');
  const sc = await scClient();
  const res = await withRetry(() =>
    sc.searchanalytics.query({
      siteUrl: prop.siteUrl,
      requestBody: { startDate: range.start, endDate: range.end, dimensions: ['searchAppearance'], dataState: 'all' },
    }),
  );
  return (res.data.rows ?? []).map((r) => ({
    appearance: r.keys![0],
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

/** Create website records for selected properties that are not yet attached to a website. */
export async function ensureWebsitesForSelected() {
  const selected = await db.select().from(searchConsoleProperties).where(eq(searchConsoleProperties.isSelected, true));
  if (!selected.length) return 0;
  const attached = await db
    .select({ id: websites.searchConsolePropertyId })
    .from(websites)
    .where(inArray(websites.searchConsolePropertyId, selected.map((s) => s.id)));
  const attachedIds = new Set(attached.map((a) => a.id));
  let created = 0;
  for (const p of selected) {
    if (attachedIds.has(p.id)) continue;
    const domain = domainOf(p.siteUrl);
    const res = await db
      .insert(websites)
      .values({ name: domain, domain, searchConsolePropertyId: p.id })
      .onConflictDoUpdate({ target: websites.domain, set: { searchConsolePropertyId: p.id, updatedAt: new Date() } })
      .returning({ id: websites.id });
    created += res.length;
  }
  return created;
}
