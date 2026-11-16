import { eq, sql } from 'drizzle-orm';
import { db, rawRows } from '../db/client.js';
import {
  websites,
  searchConsoleProperties,
  ga4Properties,
  androidApps,
  playConsoleApps,
  admobApps,
} from '../db/schema.js';
import { pctChange, type Range } from '../lib/dates.js';
import { getSettings } from './settings.js';
import { seoTotals, ga4Totals, admobTotals, vitalsSummary, classifyHealth, type HealthStatus } from './metrics.js';

export type IntegrationState = 'connected' | 'not_connected' | 'error' | 'syncing' | 'never_synced';

const state = (p: { syncStatus: string; isAccessible: boolean } | null | undefined): IntegrationState => {
  if (!p) return 'not_connected';
  if (!p.isAccessible || p.syncStatus === 'failed') return 'error';
  if (p.syncStatus === 'running') return 'syncing';
  if (p.syncStatus === 'never') return 'never_synced';
  return 'connected';
};

/** SEO health 0-100 from available evidence only; null when there is no Search Console data. */
function seoHealth(cur: Awaited<ReturnType<typeof seoTotals>>, prev: Awaited<ReturnType<typeof seoTotals>>, sitemapErrors: number) {
  if (cur.impressions == null) return null;
  let score = 70;
  const ch = pctChange(cur.clicks, prev.clicks);
  if (ch != null) score += Math.max(-25, Math.min(15, ch / 2));
  if (cur.ctr != null) score += cur.ctr >= 0.03 ? 5 : cur.ctr < 0.01 ? -5 : 0;
  if (cur.position != null) score += cur.position <= 10 ? 10 : cur.position > 30 ? -10 : 0;
  score -= Math.min(20, sitemapErrors * 5);
  return Math.round(Math.max(0, Math.min(100, score)));
}

export async function websiteRows(cur: Range, prev: Range) {
  const rows = await db
    .select({ w: websites, sc: searchConsoleProperties, ga: ga4Properties })
    .from(websites)
    .leftJoin(searchConsoleProperties, eq(searchConsoleProperties.id, websites.searchConsolePropertyId))
    .leftJoin(ga4Properties, eq(ga4Properties.id, websites.ga4PropertyId))
    .orderBy(websites.name);
  const sitemapErr = await rawRows<{ id: string; errors: number }>(sql`
    select search_console_property_id::text id, coalesce(sum(errors),0)::int errors from sitemap_records group by 1`);
  const errMap = new Map(sitemapErr.map((r) => [r.id, Number(r.errors)]));

  return Promise.all(
    rows.map(async ({ w, sc, ga }) => {
      const scIds = sc ? [sc.id] : [];
      const gaIds = ga ? [ga.id] : [];
      const [c, p, gc, gp] = await Promise.all([seoTotals(scIds, cur), seoTotals(scIds, prev), ga4Totals(gaIds, cur), ga4Totals(gaIds, prev)]);
      const lastSync = [sc?.lastSyncedAt, ga?.lastSyncedAt].filter(Boolean).sort().pop() ?? null;
      return {
        id: w.id,
        name: w.name,
        domain: w.domain,
        isMonitored: w.isMonitored,
        searchConsole: sc ? { id: sc.id, siteUrl: sc.siteUrl, status: state(sc), lastSyncedAt: sc.lastSyncedAt, lastError: sc.lastError } : null,
        ga4: ga ? { id: ga.id, name: ga.displayName, propertyName: ga.propertyName, status: state(ga), lastSyncedAt: ga.lastSyncedAt, lastError: ga.lastError } : null,
        lastSyncedAt: lastSync,
        clicks: c.clicks,
        impressions: c.impressions,
        ctr: c.ctr,
        position: c.position,
        clicksChangePct: pctChange(c.clicks, p.clicks),
        impressionsChangePct: pctChange(c.impressions, p.impressions),
        activeUsersDailySum: gc.activeUsersDailySum,
        sessions: gc.sessions,
        sessionsChangePct: pctChange(gc.sessions, gp.sessions),
        freshDays: c.freshDays,
        seoHealth: sc ? seoHealth(c, p, errMap.get(sc.id) ?? 0) : null,
      };
    }),
  );
}

export async function appRows(cur: Range, prev: Range) {
  const s = await getSettings();
  const rows = await db
    .select({ a: androidApps, pc: playConsoleApps, am: admobApps, ga: ga4Properties })
    .from(androidApps)
    .leftJoin(playConsoleApps, eq(playConsoleApps.id, androidApps.playConsoleAppId))
    .leftJoin(admobApps, eq(admobApps.id, androidApps.admobAppId))
    .leftJoin(ga4Properties, eq(ga4Properties.id, androidApps.ga4PropertyId))
    .orderBy(androidApps.name);
  const pcIds = rows.map((r) => r.pc?.id).filter(Boolean) as string[];
  // Play data lags ~2 days: vitals use the stored range as-is, missing days simply have no rows
  const vitals = pcIds.length ? await vitalsSummary(pcIds, cur) : [];
  return Promise.all(
    rows.map(async ({ a, pc, am, ga }) => {
      const mine = pc ? vitals.filter((v) => v.appId === pc.id && !v.slice) : [];
      const crash = mine.find((v) => v.metric === 'crashRate')?.value ?? null;
      const anr = mine.find((v) => v.metric === 'anrRate')?.value ?? null;
      const health: HealthStatus = pc ? classifyHealth(crash, anr, s.thresholds) : 'no_data';
      const [rev, prevRev] = am ? await Promise.all([admobTotals(cur, [am.appId]), admobTotals(prev, [am.appId])]) : [[], []];
      const [gc] = ga ? await Promise.all([ga4Totals([ga.id], cur)]) : [null];
      return {
        id: a.id,
        name: a.name,
        packageName: a.packageName,
        platform: a.platform,
        source: a.source,
        isMonitored: a.isMonitored,
        playConsole: pc ? { id: pc.id, status: pc.syncStatus, lastSyncedAt: pc.lastSyncedAt, lastError: pc.lastError, isSelected: pc.isSelected } : null,
        admob: am ? { id: am.id, appId: am.appId, displayName: am.displayName } : null,
        ga4: ga ? { id: ga.id, name: ga.displayName } : null,
        lastSyncedAt: [pc?.lastSyncedAt].filter(Boolean)[0] ?? null,
        crashRate: crash,
        anrRate: anr,
        health,
        activeUsersDailySum: gc?.activeUsersDailySum ?? null,
        earnings: rev.map((r) => ({ currency: r.currency, earnings: r.earnings, impressions: r.impressions, ecpm: r.ecpm })),
        earningsChangePct: rev[0] && prevRev[0] ? pctChange(rev[0].earnings, prevRev.find((x) => x.currency === rev[0].currency)?.earnings) : null,
      };
    }),
  );
}

export async function portfolioOverview(cur: Range, prev: Range) {
  const [sites, apps, seoC, seoP, gaC, gaP, adC, adP] = await Promise.all([
    websiteRows(cur, prev),
    appRows(cur, prev),
    seoTotals(null, cur),
    seoTotals(null, prev),
    ga4Totals(null, cur),
    ga4Totals(null, prev),
    admobTotals(cur),
    admobTotals(prev),
  ]);
  const appGa = apps.filter((a) => a.activeUsersDailySum != null);
  return {
    range: cur,
    previousRange: prev,
    websites: sites.filter((s) => s.isMonitored).length,
    androidApps: apps.filter((a) => a.isMonitored).length,
    search: {
      clicks: seoC.clicks,
      impressions: seoC.impressions,
      ctr: seoC.ctr,
      position: seoC.position,
      clicksChangePct: pctChange(seoC.clicks, seoP.clicks),
      impressionsChangePct: pctChange(seoC.impressions, seoP.impressions),
      ctrChange: seoC.ctr != null && seoP.ctr != null ? seoC.ctr - seoP.ctr : null,
      positionChange: seoC.position != null && seoP.position != null ? seoP.position - seoC.position : null,
      freshDays: seoC.freshDays,
    },
    web: {
      activeUsersDailySum: gaC.activeUsersDailySum,
      sessions: gaC.sessions,
      sessionsChangePct: pctChange(gaC.sessions, gaP.sessions),
      activeUsersChangePct: pctChange(gaC.activeUsersDailySum, gaP.activeUsersDailySum),
    },
    appActiveUsersDailySum: appGa.length ? appGa.reduce((s, a) => s + (a.activeUsersDailySum ?? 0), 0) : null,
    admob: adC.map((c) => {
      const p = adP.find((x) => x.currency === c.currency);
      return { ...c, earningsChangePct: pctChange(c.earnings, p?.earnings), impressionsChangePct: pctChange(c.impressions, p?.impressions) };
    }),
    appsRequiringAttention: apps.filter((a) => a.health === 'needs_attention' || a.health === 'critical').map((a) => ({ id: a.id, name: a.name, health: a.health, crashRate: a.crashRate, anrRate: a.anrRate })),
    decliningWebsites: sites
      .filter((s) => (s.clicksChangePct != null && s.clicksChangePct <= -10) || (s.sessionsChangePct != null && s.sessionsChangePct <= -10))
      .map((s) => ({ id: s.id, name: s.name, clicksChangePct: s.clicksChangePct, sessionsChangePct: s.sessionsChangePct })),
    topWebsites: [...sites].sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1)).slice(0, 8),
    topApps: [...apps].sort((a, b) => (b.earnings[0]?.earnings ?? -1) - (a.earnings[0]?.earnings ?? -1)).slice(0, 8),
  };
}
