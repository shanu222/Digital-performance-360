/** Websites, SEO, keywords, pages, indexing, sitemaps, analytics, overview. */
import { Router, type Response } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { websites, searchConsoleProperties, ga4Properties, sitemapRecords, urlInspections, aiInsights } from '../db/schema.js';
import { h, ok, parse, notFound, badRequest } from '../lib/http.js';
import { requireAuth, csrfProtection } from '../middleware/auth.js';
import { rangeFrom, idParam, uuid } from './_shared.js';
import { addDays, pctChange, resolveRange, todayIn, monthStart, prevMonthRange } from '../lib/dates.js';
import { toCsv } from '../lib/util.js';
import { errorMessage } from '../lib/logger.js';
import { seoTotals, seoTimeseries, dimensionTable, dimensionTrend, breakdown, ga4Totals, ga4Timeseries } from '../services/metrics.js';
import { websiteRows, portfolioOverview } from '../services/portfolio.js';
import { inspectUrl, liveSearchAppearance } from '../services/google/searchConsole.js';
import { ga4RangeTotals, ga4Realtime } from '../services/google/ga4.js';
import { enqueue } from '../services/sync/queue.js';
import { getSettings } from '../services/settings.js';
import { admobGrouped } from '../services/metrics.js';

const guard = [requireAuth, csrfProtection];

/** Resolve ?websiteId to the Search Console / GA4 property ids (null = all selected). */
async function scope(q: Record<string, unknown>) {
  if (q.websiteId) {
    const id = parse(uuid, q.websiteId);
    const [w] = await db.select().from(websites).where(eq(websites.id, id));
    if (!w) throw notFound('Website');
    return { website: w, scIds: w.searchConsolePropertyId ? [w.searchConsolePropertyId] : [], gaIds: w.ga4PropertyId ? [w.ga4PropertyId] : [] };
  }
  if (q.ga4PropertyId) return { website: null, scIds: [] as string[], gaIds: [parse(uuid, q.ga4PropertyId)] };
  return { website: null, scIds: null, gaIds: null };
}

function sendCsv(res: Response, name: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`);
  res.send('﻿' + csv);
}

/* ------------------------------ overview ------------------------------ */

export const overview = Router();
overview.use(...guard);
overview.get(
  '/',
  h(async (req, res) => {
    const r = await rangeFrom(req);
    const [data, seoTs, gaTs, revTs] = await Promise.all([
      portfolioOverview(r.current, r.previous),
      seoTimeseries(null, r.current),
      ga4Timeseries(null, r.current),
      admobGrouped('date', r.current),
    ]);
    ok(res, { ...data, timeseries: { search: seoTs, traffic: gaTs, revenue: revTs } }, { range: r.current, previous: r.previous, timezone: r.timezone });
  }),
);

/* ------------------------------ websites ------------------------------ */

export const websitesRouter = Router();
websitesRouter.use(...guard);

websitesRouter.get(
  '/',
  h(async (req, res) => {
    const r = await rangeFrom(req);
    ok(res, await websiteRows(r.current, r.previous), { range: r.current, previous: r.previous });
  }),
);

const websiteBody = z.object({
  name: z.string().min(1).max(120),
  domain: z.string().min(3).max(253).transform((d) => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase()),
  searchConsolePropertyId: uuid.nullable().optional(),
  ga4PropertyId: uuid.nullable().optional(),
});

websitesRouter.post(
  '/',
  h(async (req, res) => {
    const b = parse(websiteBody, req.body);
    const [row] = await db.insert(websites).values(b).returning();
    if (b.searchConsolePropertyId) {
      await db.update(searchConsoleProperties).set({ isSelected: true }).where(eq(searchConsoleProperties.id, b.searchConsolePropertyId));
      await enqueue('search_console', { targetId: b.searchConsolePropertyId, trigger: 'manual' });
    }
    if (b.ga4PropertyId) {
      await db.update(ga4Properties).set({ isSelected: true }).where(eq(ga4Properties.id, b.ga4PropertyId));
      await enqueue('ga4', { targetId: b.ga4PropertyId, trigger: 'manual' });
    }
    ok(res, row, undefined, 201);
  }),
);

websitesRouter.patch(
  '/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const b = parse(websiteBody.partial().extend({ isMonitored: z.boolean().optional() }), req.body);
    const [row] = await db.update(websites).set({ ...b, updatedAt: new Date() }).where(eq(websites.id, id)).returning();
    if (!row) throw notFound('Website');
    if (b.searchConsolePropertyId) {
      await db.update(searchConsoleProperties).set({ isSelected: true }).where(eq(searchConsoleProperties.id, b.searchConsolePropertyId));
      await enqueue('search_console', { targetId: b.searchConsolePropertyId, trigger: 'manual' });
    }
    if (b.ga4PropertyId) {
      await db.update(ga4Properties).set({ isSelected: true }).where(eq(ga4Properties.id, b.ga4PropertyId));
      await enqueue('ga4', { targetId: b.ga4PropertyId, trigger: 'manual' });
    }
    ok(res, row);
  }),
);

/** Removes the website from monitoring (properties and their history are kept). */
websitesRouter.delete(
  '/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const [row] = await db.delete(websites).where(eq(websites.id, id)).returning();
    if (!row) throw notFound('Website');
    if (row.searchConsolePropertyId) await db.update(searchConsoleProperties).set({ isSelected: false }).where(eq(searchConsoleProperties.id, row.searchConsolePropertyId));
    ok(res, { deleted: true });
  }),
);

websitesRouter.get(
  '/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const r = await rangeFrom(req);
    const [row] = await db
      .select({ w: websites, sc: searchConsoleProperties, ga: ga4Properties })
      .from(websites)
      .leftJoin(searchConsoleProperties, eq(searchConsoleProperties.id, websites.searchConsolePropertyId))
      .leftJoin(ga4Properties, eq(ga4Properties.id, websites.ga4PropertyId))
      .where(eq(websites.id, id));
    if (!row) throw notFound('Website');
    const scIds = row.sc ? [row.sc.id] : [];
    const gaIds = row.ga ? [row.ga.id] : [];
    const [sc, scPrev, scTs, ga, gaPrev, gaTs, kw, pages, countries, gaCountries, maps, inspections, insights] = await Promise.all([
      seoTotals(scIds, r.current),
      seoTotals(scIds, r.previous),
      seoTimeseries(scIds, r.current),
      ga4Totals(gaIds, r.current),
      ga4Totals(gaIds, r.previous),
      ga4Timeseries(gaIds, r.current),
      dimensionTable('query', scIds, r.current, r.previous, { limit: 10 }),
      dimensionTable('page', scIds, r.current, r.previous, { limit: 10 }),
      breakdown('search_console', scIds, 'country', r.current, 10),
      breakdown('ga4', gaIds, 'country', r.current, 10),
      row.sc ? db.select().from(sitemapRecords).where(eq(sitemapRecords.searchConsolePropertyId, row.sc.id)) : [],
      row.sc ? db.select().from(urlInspections).where(eq(urlInspections.searchConsolePropertyId, row.sc.id)).orderBy(desc(urlInspections.inspectedAt)).limit(10) : [],
      db.select().from(aiInsights).where(and(eq(aiInsights.entityType, 'website'), eq(aiInsights.entityId, id), eq(aiInsights.isDismissed, false))).orderBy(desc(aiInsights.generatedForDate)).limit(12),
    ]);
    ok(
      res,
      {
        website: row.w,
        searchConsole: row.sc,
        ga4: row.ga,
        seo: { current: sc, previous: scPrev, timeseries: scTs, keywords: kw.rows, pages: pages.rows, countries },
        traffic: { current: ga, previous: gaPrev, timeseries: gaTs, countries: gaCountries },
        sitemaps: maps,
        inspections,
        insights,
      },
      { range: r.current, previous: r.previous },
    );
  }),
);

/* -------------------------------- SEO -------------------------------- */

export const seo = Router();
seo.use(...guard);

seo.get(
  '/summary',
  h(async (req, res) => {
    const r = await rangeFrom(req);
    const s = await scope(req.query);
    const [c, p, ts, countries, devices] = await Promise.all([
      seoTotals(s.scIds, r.current),
      seoTotals(s.scIds, r.previous),
      seoTimeseries(s.scIds, r.current),
      breakdown('search_console', s.scIds, 'country', r.current, 25),
      breakdown('search_console', s.scIds, 'device', r.current, 5),
    ]);
    ok(
      res,
      {
        current: c,
        previous: p,
        change: { clicks: pctChange(c.clicks, p.clicks), impressions: pctChange(c.impressions, p.impressions), ctr: c.ctr != null && p.ctr != null ? c.ctr - p.ctr : null, position: c.position != null && p.position != null ? p.position - c.position : null },
        timeseries: ts,
        countries,
        devices,
      },
      { range: r.current, previous: r.previous, source: 'Google Search Console', note: 'Recent days may be preliminary (labelled "fresh").' },
    );
  }),
);

seo.get(
  '/search-appearance',
  h(async (req, res) => {
    const r = await rangeFrom(req);
    const s = await scope(req.query);
    if (!s.website?.searchConsolePropertyId) throw badRequest('websiteId with a Search Console property is required');
    try {
      ok(res, await liveSearchAppearance(s.website.searchConsolePropertyId, r.current), { range: r.current, live: true });
    } catch (err) {
      ok(res, [], { range: r.current, unavailable: errorMessage(err) });
    }
  }),
);

const tableQuery = z.object({
  search: z.string().max(200).optional(),
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().min(1).max(1000).default(50),
  offset: z.coerce.number().min(0).default(0),
  filter: z.enum(['all', 'gaining_impressions', 'losing_clicks', 'improving', 'declining', 'low_ctr', 'opportunity']).default('all'),
  format: z.enum(['json', 'csv']).default('json'),
});

function tableRoute(kind: 'query' | 'page') {
  const r = Router();
  r.use(...guard);
  r.get(
    '/',
    h(async (req, res) => {
      const range = await rangeFrom(req);
      const s = await scope(req.query);
      const q = parse(tableQuery, req.query);
      const limit = q.format === 'csv' ? 1000 : q.limit;
      const t = await dimensionTable(kind, s.scIds, range.current, range.previous, { ...q, limit });
      if (q.format === 'csv') {
        const label = kind === 'query' ? 'Keyword' : 'Page';
        return sendCsv(
          res,
          `${kind === 'query' ? 'keywords' : 'pages'}_${range.current.start}_${range.current.end}.csv`,
          toCsv(
            [label, 'Clicks', 'Impressions', 'CTR', 'Avg position', 'Previous clicks', 'Previous position', 'Position change', 'Signals'],
            t.rows.map((x) => [x.key, x.clicks, x.impressions, x.ctr == null ? '' : (x.ctr * 100).toFixed(2) + '%', x.position?.toFixed(2), x.prevClicks, x.prevPosition?.toFixed(2), x.positionChange?.toFixed(2), x.flags.join(' ')]),
          ),
        );
      }
      ok(res, t.rows, { total: t.total, limit: q.limit, offset: q.offset, range: range.current, previous: range.previous, note: 'Positions are averages over each period; Search Console does not provide exact daily rankings.' });
    }),
  );
  r.get(
    '/trend',
    h(async (req, res) => {
      const range = await rangeFrom(req);
      const s = await scope(req.query);
      const key = parse(z.string().min(1).max(2048), req.query.key);
      ok(res, await dimensionTrend(kind, s.scIds, key, range.current), { range: range.current });
    }),
  );
  return r;
}
export const keywords = tableRoute('query');
export const pages = tableRoute('page');

export const indexing = Router();
indexing.use(...guard);
indexing.get(
  '/',
  h(async (req, res) => {
    const s = await scope(req.query);
    const where = s.scIds === null ? undefined : s.scIds.length ? eq(urlInspections.searchConsolePropertyId, s.scIds[0]) : sql`false`;
    const rows = await db
      .select({ i: urlInspections, siteUrl: searchConsoleProperties.siteUrl })
      .from(urlInspections)
      .innerJoin(searchConsoleProperties, eq(searchConsoleProperties.id, urlInspections.searchConsolePropertyId))
      .where(where)
      .orderBy(desc(urlInspections.inspectedAt))
      .limit(200);
    ok(
      res,
      rows.map((r) => ({ ...r.i, raw: undefined, siteUrl: r.siteUrl })),
      { note: 'URL Inspection results are individual inspections, not a complete index of the site. Aggregated page-indexing reports are available in Search Console itself.' },
    );
  }),
);
indexing.post(
  '/inspect',
  h(async (req, res) => {
    const b = parse(z.object({ websiteId: uuid, url: z.string().url().max(2048) }), req.body);
    const [w] = await db.select().from(websites).where(eq(websites.id, b.websiteId));
    if (!w?.searchConsolePropertyId) throw badRequest('This website has no Search Console property connected');
    ok(res, await inspectUrl(w.searchConsolePropertyId, b.url));
  }),
);

export const sitemaps = Router();
sitemaps.use(...guard);
sitemaps.get(
  '/',
  h(async (req, res) => {
    const s = await scope(req.query);
    const where = s.scIds === null ? undefined : s.scIds.length ? eq(sitemapRecords.searchConsolePropertyId, s.scIds[0]) : sql`false`;
    const rows = await db
      .select({ m: sitemapRecords, siteUrl: searchConsoleProperties.siteUrl })
      .from(sitemapRecords)
      .innerJoin(searchConsoleProperties, eq(searchConsoleProperties.id, sitemapRecords.searchConsolePropertyId))
      .where(where)
      .orderBy(sitemapRecords.path);
    ok(res, rows.map((r) => ({ ...r.m, siteUrl: r.siteUrl })));
  }),
);

/* ------------------------------ analytics ------------------------------ */

export const analytics = Router();
analytics.use(...guard);

analytics.get(
  '/summary',
  h(async (req, res) => {
    const r = await rangeFrom(req);
    const s = await scope(req.query);
    const [c, p, ts, countries, devices, channels, pagesBd] = await Promise.all([
      ga4Totals(s.gaIds, r.current),
      ga4Totals(s.gaIds, r.previous),
      ga4Timeseries(s.gaIds, r.current),
      breakdown('ga4', s.gaIds, 'country', r.current, 50),
      breakdown('ga4', s.gaIds, 'device', r.current, 5),
      breakdown('ga4', s.gaIds, 'channel', r.current, 12),
      breakdown('ga4', s.gaIds, 'page', r.current, 25),
    ]);
    // Deduplicated users over the range need a live query (users are not additive across days)
    let live: Record<string, unknown> | null = null;
    let liveError: string | null = null;
    if (s.gaIds && s.gaIds.length === 1) {
      try {
        live = await ga4RangeTotals(s.gaIds[0], r.current);
      } catch (err) {
        liveError = errorMessage(err);
      }
    }
    ok(
      res,
      {
        current: c,
        previous: p,
        live,
        change: {
          sessions: pctChange(c.sessions, p.sessions),
          activeUsers: pctChange(c.activeUsersDailySum, p.activeUsersDailySum),
          newUsers: pctChange(c.newUsers, p.newUsers),
          views: pctChange(c.screenPageViews, p.screenPageViews),
          keyEvents: pctChange(c.keyEvents, p.keyEvents),
        },
        timeseries: ts,
        countries,
        devices,
        channels,
        pages: pagesBd,
      },
      { range: r.current, previous: r.previous, source: 'Google Analytics 4', liveError },
    );
  }),
);

/** Standard comparisons for one property: today vs yesterday, 7v7, 28v28, month vs previous month. */
analytics.get(
  '/comparisons',
  h(async (req, res) => {
    const s = await scope(req.query);
    if (!s.gaIds) throw badRequest('websiteId or ga4PropertyId is required');
    const tz = (await getSettings()).general.timezone;
    const today = todayIn(tz);
    const yday = addDays(today, -1);
    const periods = {
      today_vs_yesterday: { current: { start: today, end: today }, previous: { start: yday, end: yday } },
      last7_vs_prev7: resolveRange('last7', tz),
      last28_vs_prev28: resolveRange('last28', tz),
      month_vs_prev_month: { current: { start: monthStart(today), end: today }, previous: prevMonthRange(today) },
    };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(periods)) {
      const [c, p] = await Promise.all([ga4Totals(s.gaIds, v.current), ga4Totals(s.gaIds, v.previous)]);
      out[k] = {
        current: v.current,
        previous: v.previous,
        sessions: { current: c.sessions, previous: p.sessions, change: pctChange(c.sessions, p.sessions) },
        activeUsers: { current: c.activeUsersDailySum, previous: p.activeUsersDailySum, change: pctChange(c.activeUsersDailySum, p.activeUsersDailySum) },
        views: { current: c.screenPageViews, previous: p.screenPageViews, change: pctChange(c.screenPageViews, p.screenPageViews) },
        keyEvents: { current: c.keyEvents, previous: p.keyEvents, change: pctChange(c.keyEvents, p.keyEvents) },
        partial: k === 'today_vs_yesterday' || k === 'month_vs_prev_month',
      };
    }
    ok(res, out, { note: 'Today and month-to-date are partial periods.' });
  }),
);

analytics.get(
  '/realtime',
  h(async (req, res) => {
    const s = await scope(req.query);
    if (!s.gaIds?.length) throw badRequest('websiteId or ga4PropertyId with GA4 connected is required');
    ok(res, await ga4Realtime(s.gaIds[0]), { source: 'GA4 Realtime API (last 30 minutes)' });
  }),
);

analytics.get(
  '/properties',
  h(async (_req, res) => {
    ok(res, await db.select().from(ga4Properties).where(eq(ga4Properties.isSelected, true)).orderBy(ga4Properties.displayName));
  }),
);
