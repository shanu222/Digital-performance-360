/** Android apps, Play health, AdMob revenue, AI, reports. */
import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { androidApps, playConsoleApps, admobApps, ga4Properties, appDailyMetrics, aiInsights, reportFiles, dailyReports } from '../db/schema.js';
import { h, ok, parse, notFound, badRequest, AppError } from '../lib/http.js';
import { requireAuth, csrfProtection } from '../middleware/auth.js';
import { rangeFrom, rangeFromQuery, idParam, uuid } from './_shared.js';
import { addDays, pctChange, todayIn, monthStart, prevMonthRange, resolveRange } from '../lib/dates.js';
import { chunk } from '../lib/util.js';
import { appRows } from '../services/portfolio.js';
import { vitalsSummary, vitalsTimeseries, classifyHealth, admobTotals, admobGrouped, ga4Totals, ga4Timeseries, breakdown } from '../services/metrics.js';
import { getSettings } from '../services/settings.js';
import { enqueue } from '../services/sync/queue.js';
import { getRate } from '../services/fx.js';
import { chat, aiConfigured } from '../services/ai.js';
import { buildReport, REPORT_TYPES } from '../services/reports/builder.js';
import { renderPdf, renderExcel, renderCsv } from '../services/reports/render.js';
import { generateDailyReport, listDailyReports, dailyEmailHtml } from '../services/reports/daily.js';
import rateLimit from 'express-rate-limit';

const guard = [requireAuth, csrfProtection];

/* ---------------------------- android apps ---------------------------- */

export const androidAppsRouter = Router();
androidAppsRouter.use(...guard);

androidAppsRouter.get(
  '/',
  h(async (req, res) => {
    const r = await rangeFrom(req);
    ok(res, await appRows(r.current, r.previous), { range: r.current, previous: r.previous });
  }),
);

const appBody = z.object({
  name: z.string().min(1).max(120),
  packageName: z.string().regex(/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/, 'Invalid Android package name'),
  playConsoleAppId: uuid.nullable().optional(),
  admobAppId: uuid.nullable().optional(),
  ga4PropertyId: uuid.nullable().optional(),
});

androidAppsRouter.post(
  '/',
  h(async (req, res) => {
    const b = parse(appBody, req.body);
    const [pc] = await db.select().from(playConsoleApps).where(eq(playConsoleApps.packageName, b.packageName));
    const [am] = await db.select().from(admobApps).where(eq(admobApps.storeId, b.packageName));
    const [row] = await db
      .insert(androidApps)
      .values({ ...b, playConsoleAppId: b.playConsoleAppId ?? pc?.id ?? null, admobAppId: b.admobAppId ?? am?.id ?? null, source: 'manual' })
      .returning();
    ok(res, row, undefined, 201);
  }),
);

androidAppsRouter.patch(
  '/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const b = parse(appBody.partial().extend({ isMonitored: z.boolean().optional() }), req.body);
    const [row] = await db.update(androidApps).set({ ...b, updatedAt: new Date() }).where(eq(androidApps.id, id)).returning();
    if (!row) throw notFound('App');
    if (b.playConsoleAppId) {
      await db.update(playConsoleApps).set({ isSelected: true }).where(eq(playConsoleApps.id, b.playConsoleAppId));
      await enqueue('play_reporting', { targetId: b.playConsoleAppId, trigger: 'manual' });
    }
    if (b.ga4PropertyId) {
      await db.update(ga4Properties).set({ isSelected: true }).where(eq(ga4Properties.id, b.ga4PropertyId));
      await enqueue('ga4', { targetId: b.ga4PropertyId, trigger: 'manual' });
    }
    ok(res, row);
  }),
);

androidAppsRouter.delete(
  '/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const [row] = await db.delete(androidApps).where(eq(androidApps.id, id)).returning();
    if (!row) throw notFound('App');
    ok(res, { deleted: true });
  }),
);

androidAppsRouter.get(
  '/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const r = await rangeFrom(req);
    const s = await getSettings();
    const [row] = await db
      .select({ a: androidApps, pc: playConsoleApps, am: admobApps, ga: ga4Properties })
      .from(androidApps)
      .leftJoin(playConsoleApps, eq(playConsoleApps.id, androidApps.playConsoleAppId))
      .leftJoin(admobApps, eq(admobApps.id, androidApps.admobAppId))
      .leftJoin(ga4Properties, eq(ga4Properties.id, androidApps.ga4PropertyId))
      .where(eq(androidApps.id, id));
    if (!row) throw notFound('App');
    const gaIds = row.ga ? [row.ga.id] : [];
    const appIds = row.am ? [row.am.appId] : [];
    const [vit, vitTs, gaC, gaP, gaTs, gaCountries, gaDevices, adC, adP, adDaily, adCountries, adFormats, acquisition, insights] = await Promise.all([
      row.pc ? vitalsSummary([row.pc.id], r.current) : Promise.resolve([]),
      row.pc ? vitalsTimeseries(row.pc.id, r.current) : Promise.resolve([]),
      ga4Totals(gaIds, r.current),
      ga4Totals(gaIds, r.previous),
      ga4Timeseries(gaIds, r.current),
      breakdown('ga4', gaIds, 'country', r.current, 15),
      breakdown('ga4', gaIds, 'device', r.current, 5),
      appIds.length ? admobTotals(r.current, appIds) : Promise.resolve([]),
      appIds.length ? admobTotals(r.previous, appIds) : Promise.resolve([]),
      appIds.length ? admobGrouped('date', r.current, appIds) : Promise.resolve([]),
      appIds.length ? admobGrouped('country', r.current, appIds) : Promise.resolve([]),
      appIds.length ? admobGrouped('format', r.current, appIds) : Promise.resolve([]),
      db
        .select({ metric: appDailyMetrics.metric, source: appDailyMetrics.source, total: sql<number>`sum(${appDailyMetrics.value})::float8`, days: sql<number>`count(*)::int` })
        .from(appDailyMetrics)
        .where(and(eq(appDailyMetrics.androidAppId, id), sql`${appDailyMetrics.metricDate} between ${r.current.start} and ${r.current.end}`))
        .groupBy(appDailyMetrics.metric, appDailyMetrics.source),
      db.select().from(aiInsights).where(and(eq(aiInsights.entityType, 'android_app'), eq(aiInsights.entityId, id), eq(aiInsights.isDismissed, false))).orderBy(desc(aiInsights.generatedForDate)).limit(12),
    ]);
    const appLevel = vit.filter((v) => !v.slice);
    const crash = appLevel.find((v) => v.metric === 'crashRate')?.value ?? null;
    const anr = appLevel.find((v) => v.metric === 'anrRate')?.value ?? null;
    ok(
      res,
      {
        app: row.a,
        playConsole: row.pc,
        admob: row.am,
        ga4: row.ga,
        health: { status: row.pc ? classifyHealth(crash, anr, s.thresholds) : 'no_data', crashRate: crash, anrRate: anr, thresholds: s.thresholds },
        vitals: vit,
        vitalsTimeseries: vitTs,
        analytics: row.ga ? { current: gaC, previous: gaP, timeseries: gaTs, countries: gaCountries, devices: gaDevices } : null,
        revenue: row.am
          ? { current: adC.map((c) => ({ ...c, earningsChangePct: pctChange(c.earnings, adP.find((p) => p.currency === c.currency)?.earnings) })), daily: adDaily, countries: adCountries, formats: adFormats }
          : null,
        acquisition,
        insights,
      },
      { range: r.current, previous: r.previous },
    );
  }),
);

/**
 * CSV import for acquisition/install metrics that no approved API exposes
 * (e.g. Play Console "Statistics" export). Format: date,metric,value  (header row required)
 */
androidAppsRouter.post(
  '/:id/import',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ csv: z.string().min(10).max(5_000_000), fileName: z.string().max(200).default('import.csv') }), req.body);
    const [app] = await db.select().from(androidApps).where(eq(androidApps.id, id));
    if (!app) throw notFound('App');
    const lines = b.csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    const header = lines.shift()!.split(',').map((x) => x.trim().toLowerCase());
    const di = header.indexOf('date');
    if (di < 0) throw badRequest('CSV must have a "date" column');
    // Long format (date,metric,value) or wide format (date,<metric1>,<metric2>...)
    const long = header.includes('metric') && header.includes('value');
    const rows: Array<typeof appDailyMetrics.$inferInsert> = [];
    const errors: string[] = [];
    lines.forEach((line, i) => {
      const cells = line.split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
      const date = cells[di];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return void errors.push(`row ${i + 2}: invalid date "${date}"`);
      const add = (metric: string, raw: string) => {
        if (raw === '' || raw == null) return;
        const v = Number(raw.replace(/[^\d.-]/g, ''));
        if (!Number.isFinite(v)) return void errors.push(`row ${i + 2}: invalid number for ${metric}`);
        rows.push({ androidAppId: id, metricDate: date, metric: metric.slice(0, 80), value: v, source: `csv_import:${b.fileName}`.slice(0, 200) });
      };
      if (long) add(cells[header.indexOf('metric')], cells[header.indexOf('value')]);
      else header.forEach((h2, j) => j !== di && add(h2, cells[j]));
    });
    if (errors.length > 50) throw new AppError(422, 'csv_invalid', 'Too many invalid rows', errors.slice(0, 50));
    for (const part of chunk(rows, 1000)) {
      await db
        .insert(appDailyMetrics)
        .values(part)
        .onConflictDoUpdate({ target: [appDailyMetrics.androidAppId, appDailyMetrics.metricDate, appDailyMetrics.metric, appDailyMetrics.source], set: { value: sql`excluded.value`, retrievedAt: new Date() } });
    }
    ok(res, { imported: rows.length, errors });
  }),
);

androidAppsRouter.post(
  '/:id/sync',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const [a] = await db.select().from(androidApps).where(eq(androidApps.id, id));
    if (!a) throw notFound('App');
    const jobs = [];
    if (a.playConsoleAppId) jobs.push((await enqueue('play_reporting', { targetId: a.playConsoleAppId, trigger: 'manual' })).job);
    if (a.ga4PropertyId) jobs.push((await enqueue('ga4', { targetId: a.ga4PropertyId, trigger: 'manual' })).job);
    if (a.admobAppId) jobs.push((await enqueue('admob', { trigger: 'manual' })).job);
    ok(res, { jobs }, undefined, 202);
  }),
);

/* ------------------------- play console / health ------------------------- */

export const playConsole = Router();
playConsole.use(...guard);
playConsole.get('/apps', h(async (_req, res) => ok(res, await db.select().from(playConsoleApps).orderBy(playConsoleApps.displayName))));

export const appHealth = Router();
appHealth.use(...guard);
appHealth.get(
  '/',
  h(async (req, res) => {
    const r = await rangeFrom(req);
    const s = await getSettings();
    const apps = await db.select().from(playConsoleApps).where(eq(playConsoleApps.isSelected, true)).orderBy(playConsoleApps.displayName);
    const v = await vitalsSummary(apps.map((a) => a.id), r.current);
    const prev = await vitalsSummary(apps.map((a) => a.id), r.previous);
    const linked = await db.select({ id: androidApps.id, pc: androidApps.playConsoleAppId }).from(androidApps);
    ok(
      res,
      apps.map((a) => {
        const mine = v.filter((x) => x.appId === a.id);
        const get = (m: string, list = mine) => list.find((x) => x.metric === m && !x.slice)?.value ?? null;
        const p = prev.filter((x) => x.appId === a.id);
        return {
          playApp: a,
          androidAppId: linked.find((l) => l.pc === a.id)?.id ?? null,
          status: classifyHealth(get('crashRate'), get('anrRate'), s.thresholds),
          metrics: Object.fromEntries(mine.filter((x) => !x.slice).map((x) => [x.metric, x.value])),
          slowStart: mine.filter((x) => x.metric === 'slowStartRate' && x.slice).map((x) => ({ slice: x.slice, value: x.value })),
          previous: { crashRate: get('crashRate', p), anrRate: get('anrRate', p) },
          latestDate: mine.reduce<string | null>((mx, x) => (!mx || x.latest > mx ? x.latest : mx), null),
        };
      }),
      { range: r.current, thresholds: s.thresholds, source: 'Google Play Developer Reporting API', note: 'Rates are % of distinct users; Play data typically lags 1–2 days.' },
    );
  }),
);
appHealth.get(
  '/:id/timeseries',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const r = await rangeFrom(req);
    ok(res, await vitalsTimeseries(id, r.current), { range: r.current });
  }),
);

/* -------------------------------- admob -------------------------------- */

export const admob = Router();
admob.use(...guard);

admob.get(
  '/summary',
  h(async (req, res) => {
    const tz = (await getSettings()).general.timezone;
    const today = todayIn(tz);
    const appIds = req.query.appId ? [String(req.query.appId)] : null;
    const periods = {
      today: { start: today, end: today },
      yesterday: { start: addDays(today, -1), end: addDays(today, -1) },
      last7: resolveRange('last7', tz).current,
      last30: resolveRange('last30', tz).current,
      thisMonth: { start: monthStart(today), end: today },
      previousMonth: prevMonthRange(today),
    };
    const out: Record<string, unknown> = {};
    for (const [k, rg] of Object.entries(periods)) out[k] = { range: rg, totals: await admobTotals(rg, appIds) };
    ok(res, out, { source: 'AdMob Network Report', note: 'Earnings are estimated until finalised by Google. Today’s figures are partial.' });
  }),
);

admob.get(
  '/report',
  h(async (req, res) => {
    const r = await rangeFrom(req);
    const appIds = req.query.appId ? [String(req.query.appId)] : null;
    const [totals, prev, daily, monthly, apps, countries, formats] = await Promise.all([
      admobTotals(r.current, appIds),
      admobTotals(r.previous, appIds),
      admobGrouped('date', r.current, appIds),
      admobGrouped('month', { start: addDays(r.current.end, -365), end: r.current.end }, appIds),
      admobGrouped('app', r.current, appIds),
      admobGrouped('country', r.current, appIds),
      admobGrouped('format', r.current, appIds),
    ]);
    ok(
      res,
      {
        totals: totals.map((t) => {
          const p = prev.find((x) => x.currency === t.currency);
          return { ...t, change: { earnings: pctChange(t.earnings, p?.earnings), impressions: pctChange(t.impressions, p?.impressions), ecpm: pctChange(t.ecpm, p?.ecpm), clicks: pctChange(t.clicks, p?.clicks) } };
        }),
        daily,
        monthly,
        apps,
        countries,
        formats,
      },
      { range: r.current, previous: r.previous, source: 'AdMob Network Report', estimated: true },
    );
  }),
);

admob.get('/apps', h(async (_req, res) => ok(res, await db.select().from(admobApps).orderBy(admobApps.displayName))));

/** Optional display conversion. Returns rate + source + timestamp so the UI can label it. */
admob.get(
  '/fx',
  h(async (req, res) => {
    const q = parse(z.object({ from: z.string().length(3), to: z.enum(['USD', 'PKR']) }), req.query);
    const rate = await getRate(q.from.toUpperCase(), q.to);
    if (!rate) throw new AppError(503, 'fx_unavailable', 'Exchange rate is currently unavailable');
    ok(res, { from: q.from.toUpperCase(), to: q.to, ...rate });
  }),
);

/* --------------------------------- AI --------------------------------- */

export const ai = Router();
ai.use(...guard);
const chatLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

ai.get(
  '/insights',
  h(async (req, res) => {
    const q = parse(
      z.object({ entityType: z.string().optional(), entityId: z.string().optional(), priority: z.enum(['critical', 'high', 'medium', 'low']).optional(), limit: z.coerce.number().min(1).max(200).default(100) }),
      req.query,
    );
    const conds = [eq(aiInsights.isDismissed, false)];
    if (q.entityType) conds.push(eq(aiInsights.entityType, q.entityType));
    if (q.entityId) conds.push(eq(aiInsights.entityId, q.entityId));
    if (q.priority) conds.push(eq(aiInsights.priority, q.priority));
    const rows = await db
      .select()
      .from(aiInsights)
      .where(and(...conds))
      .orderBy(desc(aiInsights.generatedForDate), sql`case ${aiInsights.priority} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`)
      .limit(q.limit);
    ok(res, rows, { configured: aiConfigured() });
  }),
);

ai.patch(
  '/insights/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { isDismissed } = parse(z.object({ isDismissed: z.boolean() }), req.body);
    const [row] = await db.update(aiInsights).set({ isDismissed }).where(eq(aiInsights.id, id)).returning();
    if (!row) throw notFound('Insight');
    ok(res, row);
  }),
);

ai.post(
  '/analyze',
  h(async (req, res) => {
    if (!aiConfigured()) throw new AppError(409, 'ai_not_configured', 'Set OPENAI_API_KEY on the backend to enable AI analysis');
    const b = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.body ?? {});
    ok(res, await enqueue('ai_analysis', { trigger: 'manual', params: b.date ? { date: b.date } : {} }), undefined, 202);
  }),
);

ai.post(
  '/chat',
  chatLimiter,
  h(async (req, res) => {
    const b = parse(z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4000) })).min(1).max(30) }), req.body);
    ok(res, await chat(b.messages));
  }),
);

/* ------------------------------- reports ------------------------------- */

export const reports = Router();
reports.use(...guard);

reports.post(
  '/generate',
  h(async (req, res) => {
    const b = parse(
      z.object({
        type: z.enum(REPORT_TYPES),
        format: z.enum(['pdf', 'xlsx', 'csv']),
        preset: z.string().default('last28'),
        start: z.string().optional(),
        end: z.string().optional(),
        websiteId: uuid.optional(),
        appId: uuid.optional(),
      }),
      req.body,
    );
    const r = await rangeFromQuery({ preset: b.preset, start: b.start, end: b.end });
    const doc = await buildReport(b.type, r.current, r.previous, { websiteId: b.websiteId, appId: b.appId });
    const content = b.format === 'pdf' ? await renderPdf(doc) : b.format === 'xlsx' ? await renderExcel(doc) : renderCsv(doc);
    const mime = b.format === 'pdf' ? 'application/pdf' : b.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv';
    const fileName = `dp360-${b.type}-${r.current.start}_${r.current.end}.${b.format}`;
    const [row] = await db
      .insert(reportFiles)
      .values({ reportType: b.type, format: b.format, title: doc.title, params: { ...b, range: r.current }, fileName, mimeType: mime, sizeBytes: content.length, content })
      .returning({ id: reportFiles.id, title: reportFiles.title, fileName: reportFiles.fileName, format: reportFiles.format, sizeBytes: reportFiles.sizeBytes, createdAt: reportFiles.createdAt });
    ok(res, row, undefined, 201);
  }),
);

reports.get(
  '/',
  h(async (_req, res) => {
    ok(
      res,
      await db
        .select({ id: reportFiles.id, reportType: reportFiles.reportType, format: reportFiles.format, title: reportFiles.title, fileName: reportFiles.fileName, sizeBytes: reportFiles.sizeBytes, params: reportFiles.params, createdAt: reportFiles.createdAt })
        .from(reportFiles)
        .orderBy(desc(reportFiles.createdAt))
        .limit(200),
    );
  }),
);

reports.get(
  '/files/:id/download',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const [f] = await db.select().from(reportFiles).where(eq(reportFiles.id, id));
    if (!f) throw notFound('Report');
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${f.fileName}"`);
    res.send(f.content);
  }),
);

reports.delete(
  '/files/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    await db.delete(reportFiles).where(eq(reportFiles.id, id));
    ok(res, { deleted: true });
  }),
);

reports.get('/daily', h(async (_req, res) => ok(res, await listDailyReports())));

reports.get(
  '/daily/:date',
  h(async (req, res) => {
    const date = parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), req.params.date);
    const [row] = await db.select().from(dailyReports).where(eq(dailyReports.reportDate, date));
    if (!row) throw notFound('Daily report');
    if (req.query.format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      return res.send(dailyEmailHtml(row.content as Record<string, unknown>));
    }
    ok(res, row);
  }),
);

reports.post(
  '/daily/generate',
  h(async (req, res) => {
    const b = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), email: z.boolean().default(false) }), req.body ?? {});
    const tz = (await getSettings()).general.timezone;
    ok(res, await generateDailyReport(b.date ?? addDays(todayIn(tz), -1), { email: b.email }));
  }),
);
