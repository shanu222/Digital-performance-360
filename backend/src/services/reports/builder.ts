import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { websites, androidApps, admobApps, aiInsights, playConsoleApps } from '../../db/schema.js';
import { pctChange, type Range } from '../../lib/dates.js';
import { notFound, badRequest } from '../../lib/http.js';
import { getSettings } from '../settings.js';
import {
  seoTotals,
  seoTimeseries,
  dimensionTable,
  breakdown,
  ga4Totals,
  ga4Timeseries,
  admobTotals,
  admobGrouped,
  vitalsSummary,
  vitalsTimeseries,
  classifyHealth,
} from '../metrics.js';
import { portfolioOverview, websiteRows, appRows } from '../portfolio.js';

export const REPORT_TYPES = [
  'portfolio',
  'website_seo',
  'website_traffic',
  'keywords',
  'pages',
  'android_app',
  'play_health',
  'admob',
  'ai_recommendations',
  'monthly_executive',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export interface ReportKpi {
  label: string;
  value: string;
  change?: string | null;
}
export interface ReportChart {
  type: 'line' | 'bar';
  title: string;
  labels: string[];
  series: Array<{ name: string; values: Array<number | null> }>;
}
export interface ReportTable {
  title: string;
  headers: string[];
  rows: Array<Array<string | number | null>>;
}
export interface ReportSection {
  title: string;
  note?: string;
  kpis?: ReportKpi[];
  chart?: ReportChart;
  table?: ReportTable;
}
export interface ReportDoc {
  title: string;
  subtitle: string;
  period: Range;
  previousPeriod: Range;
  generatedAt: string;
  sources: string[];
  executiveSummary: string[];
  sections: ReportSection[];
}

const n0 = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));
const n2 = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }));
const pct = (v: number | null | undefined, digits = 2) => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`);
const chg = (v: number | null | undefined) => (v == null ? null : Math.abs(v) < 0.05 ? '0.0%' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const money = (v: number | null | undefined, cur: string) => (v == null ? '—' : `${cur} ${n2(v)}`);

async function seoSections(scIds: string[] | null, cur: Range, prev: Range, label: string): Promise<{ sections: ReportSection[]; summary: string[] }> {
  const [c, p, ts, kw, pages, countries, devices] = await Promise.all([
    seoTotals(scIds, cur),
    seoTotals(scIds, prev),
    seoTimeseries(scIds, cur),
    dimensionTable('query', scIds, cur, prev, { limit: 25 }),
    dimensionTable('page', scIds, cur, prev, { limit: 25 }),
    breakdown('search_console', scIds, 'country', cur, 15),
    breakdown('search_console', scIds, 'device', cur, 5),
  ]);
  const summary: string[] = [];
  if (c.clicks != null) {
    const ch = pctChange(c.clicks, p.clicks);
    summary.push(`${label}: ${n0(c.clicks)} search clicks and ${n0(c.impressions)} impressions${ch != null ? ` (${chg(ch)} clicks vs previous period)` : ''}.`);
  } else summary.push(`${label}: no Search Console data stored for this period.`);
  if (c.freshDays) summary.push(`${c.freshDays} day(s) in this period contain preliminary Search Console data that may still change.`);
  return {
    summary,
    sections: [
      {
        title: 'Search performance',
        note: 'Source: Google Search Console. Average position is impression-weighted over the period.',
        kpis: [
          { label: 'Clicks', value: n0(c.clicks), change: chg(pctChange(c.clicks, p.clicks)) },
          { label: 'Impressions', value: n0(c.impressions), change: chg(pctChange(c.impressions, p.impressions)) },
          { label: 'CTR', value: pct(c.ctr), change: c.ctr != null && p.ctr != null ? `${((c.ctr - p.ctr) * 100).toFixed(2)} pts` : null },
          { label: 'Avg position', value: c.position == null ? '—' : c.position.toFixed(1), change: c.position != null && p.position != null ? `${(p.position - c.position).toFixed(1)} pos` : null },
        ],
        chart: { type: 'line', title: 'Daily search clicks', labels: ts.map((t) => t.date), series: [{ name: 'Clicks', values: ts.map((t) => t.clicks) }] },
      },
      {
        title: 'Top keywords',
        table: {
          title: 'Top keywords by clicks',
          headers: ['Keyword', 'Clicks', 'Impressions', 'CTR', 'Avg pos', 'Prev pos', 'Pos chg'],
          rows: kw.rows.map((r) => [r.key, r.clicks, r.impressions, pct(r.ctr), r.position?.toFixed(1) ?? '—', r.prevPosition?.toFixed(1) ?? '—', r.positionChange == null ? '—' : r.positionChange.toFixed(1)]),
        },
      },
      {
        title: 'Top pages',
        table: {
          title: 'Top pages by clicks',
          headers: ['Page', 'Clicks', 'Impressions', 'CTR', 'Avg pos', 'Click change'],
          rows: pages.rows.map((r) => [r.key, r.clicks, r.impressions, pct(r.ctr), r.position?.toFixed(1) ?? '—', chg(r.clickChangePct) ?? '—']),
        },
      },
      {
        title: 'Countries & devices (search)',
        chart: { type: 'bar', title: 'Clicks by country', labels: countries.slice(0, 10).map((x) => x.value.toUpperCase()), series: [{ name: 'Clicks', values: countries.slice(0, 10).map((x) => x.clicks) }] },
        table: {
          title: 'Device breakdown',
          headers: ['Device', 'Clicks', 'Impressions', 'CTR', 'Avg pos'],
          rows: devices.map((d) => [d.value, d.clicks, d.impressions, pct(d.ctr), d.position?.toFixed(1) ?? '—']),
        },
      },
    ],
  };
}

async function trafficSections(gaIds: string[] | null, cur: Range, prev: Range, label: string): Promise<{ sections: ReportSection[]; summary: string[] }> {
  const [c, p, ts, countries, devices, channels] = await Promise.all([
    ga4Totals(gaIds, cur),
    ga4Totals(gaIds, prev),
    ga4Timeseries(gaIds, cur),
    breakdown('ga4', gaIds, 'country', cur, 15),
    breakdown('ga4', gaIds, 'device', cur, 5),
    breakdown('ga4', gaIds, 'channel', cur, 10),
  ]);
  const summary = c.sessions != null ? [`${label}: ${n0(c.sessions)} sessions (${chg(pctChange(c.sessions, p.sessions)) ?? 'no comparison'}), engagement rate ${pct(c.engagementRate, 1)}.`] : [`${label}: no GA4 data stored for this period.`];
  return {
    summary,
    sections: [
      {
        title: 'Traffic (Google Analytics 4)',
        note: 'Users are summed per day (a user active on several days is counted on each day).',
        kpis: [
          { label: 'Sessions', value: n0(c.sessions), change: chg(pctChange(c.sessions, p.sessions)) },
          { label: 'Daily active users (sum)', value: n0(c.activeUsersDailySum), change: chg(pctChange(c.activeUsersDailySum, p.activeUsersDailySum)) },
          { label: 'New users', value: n0(c.newUsers), change: chg(pctChange(c.newUsers, p.newUsers)) },
          { label: 'Engagement rate', value: pct(c.engagementRate, 1) },
          { label: 'Views', value: n0(c.screenPageViews), change: chg(pctChange(c.screenPageViews, p.screenPageViews)) },
          { label: 'Key events', value: n0(c.keyEvents), change: chg(pctChange(c.keyEvents, p.keyEvents)) },
        ],
        chart: { type: 'line', title: 'Daily sessions & active users', labels: ts.map((t) => t.date), series: [{ name: 'Sessions', values: ts.map((t) => t.sessions) }, { name: 'Active users', values: ts.map((t) => t.activeUsers) }] },
      },
      {
        title: 'Acquisition channels',
        table: { title: 'Sessions by default channel group', headers: ['Channel', 'Sessions', 'Active users', 'Engagement rate', 'Key events'], rows: channels.map((x) => [x.value, x.sessions, x.activeUsers, pct(x.engagementRate, 1), x.keyEvents]) },
      },
      {
        title: 'Countries & devices',
        chart: { type: 'bar', title: 'Sessions by country', labels: countries.slice(0, 10).map((x) => x.value), series: [{ name: 'Sessions', values: countries.slice(0, 10).map((x) => x.sessions) }] },
        table: { title: 'Devices', headers: ['Device', 'Sessions', 'Active users', 'Engagement rate'], rows: devices.map((x) => [x.value, x.sessions, x.activeUsers, pct(x.engagementRate, 1)]) },
      },
    ],
  };
}

async function admobSections(cur: Range, prev: Range, appIds?: string[]): Promise<{ sections: ReportSection[]; summary: string[] }> {
  const [c, p, daily, apps, countries, formats] = await Promise.all([
    admobTotals(cur, appIds),
    admobTotals(prev, appIds),
    admobGrouped('date', cur, appIds),
    admobGrouped('app', cur, appIds),
    admobGrouped('country', cur, appIds),
    admobGrouped('format', cur, appIds),
  ]);
  if (!c.length) return { summary: ['AdMob: no earnings data stored for this period.'], sections: [{ title: 'AdMob revenue', note: 'No AdMob data stored for this period.' }] };
  const summary = c.map((t) => {
    const pp = p.find((x) => x.currency === t.currency);
    return `AdMob estimated earnings ${money(t.earnings, t.currency)} (${chg(pctChange(t.earnings, pp?.earnings)) ?? 'no comparison'}), eCPM ${money(t.ecpm, t.currency)}.`;
  });
  const sections: ReportSection[] = c.map((t) => {
    const pp = p.find((x) => x.currency === t.currency);
    return {
      title: `AdMob revenue (${t.currency})`,
      note: 'Estimated earnings until finalised by Google. Original reporting currency shown.',
      kpis: [
        { label: 'Estimated earnings', value: money(t.earnings, t.currency), change: chg(pctChange(t.earnings, pp?.earnings)) },
        { label: 'Impressions', value: n0(t.impressions), change: chg(pctChange(t.impressions, pp?.impressions)) },
        { label: 'Clicks', value: n0(t.clicks) },
        { label: 'eCPM', value: money(t.ecpm, t.currency), change: chg(pctChange(t.ecpm, pp?.ecpm)) },
        { label: 'Match rate', value: t.matchRate == null ? '—' : `${t.matchRate.toFixed(1)}%` },
        { label: 'Show rate', value: t.showRate == null ? '—' : `${t.showRate.toFixed(1)}%` },
      ],
      chart: {
        type: 'line',
        title: 'Daily estimated earnings',
        labels: daily.filter((d) => d.currency === t.currency).map((d) => d.key),
        series: [{ name: 'Earnings', values: daily.filter((d) => d.currency === t.currency).map((d) => d.earnings) }],
      },
    };
  });
  sections.push(
    { title: 'Revenue by application', table: { title: 'Applications', headers: ['Application', 'Currency', 'Earnings', 'Impressions', 'Clicks', 'eCPM', 'Match rate'], rows: apps.map((a) => [a.label, a.currency, n2(a.earnings), a.impressions, a.clicks, n2(a.ecpm), a.matchRate == null ? '—' : `${a.matchRate.toFixed(1)}%`]) } },
    { title: 'Revenue by country', table: { title: 'Countries', headers: ['Country', 'Currency', 'Earnings', 'Impressions', 'Clicks', 'eCPM'], rows: countries.slice(0, 30).map((a) => [a.key, a.currency, n2(a.earnings), a.impressions, a.clicks, n2(a.ecpm)]) } },
    {
      title: 'Ad format performance',
      chart: { type: 'bar', title: 'Earnings by format', labels: formats.map((f) => f.key), series: [{ name: 'Earnings', values: formats.map((f) => f.earnings) }] },
      table: { title: 'Formats', headers: ['Format', 'Currency', 'Earnings', 'Impressions', 'eCPM', 'Show rate'], rows: formats.map((a) => [a.key, a.currency, n2(a.earnings), a.impressions, n2(a.ecpm), a.showRate == null ? '—' : `${a.showRate.toFixed(1)}%`]) },
    },
  );
  return { sections, summary };
}

async function vitalsSections(playIds: string[] | null, cur: Range): Promise<{ sections: ReportSection[]; summary: string[] }> {
  const s = await getSettings();
  const apps = await db.select().from(playConsoleApps).where(playIds ? undefined : eq(playConsoleApps.isSelected, true));
  const scoped = playIds ? apps.filter((a) => playIds.includes(a.id)) : apps;
  const v = await vitalsSummary(scoped.map((a) => a.id), cur);
  const rows = scoped.map((a) => {
    const m = (k: string) => v.find((x) => x.appId === a.id && x.metric === k && !x.slice)?.value ?? null;
    const status = classifyHealth(m('crashRate'), m('anrRate'), s.thresholds);
    return { a, status, crash: m('crashRate'), anr: m('anrRate'), pcrash: m('userPerceivedCrashRate'), panr: m('userPerceivedAnrRate'), render: m('slowRenderingRate20Fps'), wake: m('excessiveWakeupRate'), errors: m('errorReportCount') };
  });
  const bad = rows.filter((r) => r.status === 'critical' || r.status === 'needs_attention');
  const sections: ReportSection[] = [
    {
      title: 'Android vitals',
      note: `Source: Play Developer Reporting API. Rates are % of distinct users, user-weighted. Thresholds: crash >=${s.thresholds.crashRateWarning}% / ANR >=${s.thresholds.anrRateWarning}% need attention.`,
      table: {
        title: 'Technical health',
        headers: ['App', 'Status', 'Crash %', 'User-perceived crash %', 'ANR %', 'User-perceived ANR %', 'Slow render %', 'Excessive wakeup %', 'Error reports'],
        rows: rows.map((r) => [r.a.displayName ?? r.a.packageName, r.status.replace('_', ' '), r.crash?.toFixed(2) ?? '—', r.pcrash?.toFixed(2) ?? '—', r.anr?.toFixed(2) ?? '—', r.panr?.toFixed(2) ?? '—', r.render?.toFixed(2) ?? '—', r.wake?.toFixed(2) ?? '—', r.errors == null ? '—' : Math.round(r.errors)]),
      },
    },
  ];
  if (scoped.length === 1) {
    const ts = await vitalsTimeseries(scoped[0].id, cur);
    sections.push({ title: 'Stability trend', chart: { type: 'line', title: 'Crash & ANR rate (%)', labels: ts.map((t) => String(t.date)), series: [{ name: 'Crash rate', values: ts.map((t) => (t.crashRate as number) ?? null) }, { name: 'ANR rate', values: ts.map((t) => (t.anrRate as number) ?? null) }] } });
  }
  return { sections, summary: [rows.length ? `${bad.length} of ${rows.length} monitored app(s) need technical attention.` : 'No Play vitals stored for this period.'] };
}

async function aiSection(cur: Range, entity?: { type: string; id: string }): Promise<ReportSection> {
  const conds = [gte(aiInsights.generatedForDate, cur.start), lte(aiInsights.generatedForDate, cur.end), eq(aiInsights.isDismissed, false)];
  if (entity) conds.push(eq(aiInsights.entityType, entity.type), eq(aiInsights.entityId, entity.id));
  const rows = await db.select().from(aiInsights).where(and(...conds)).orderBy(desc(aiInsights.generatedForDate)).limit(60);
  const order = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
  rows.sort((a, b) => order[a.priority] - order[b.priority]);
  return {
    title: 'AI recommendations',
    note: 'Generated from stored analytics evidence. Recommendations do not guarantee ranking or earnings changes.',
    table: {
      title: 'Recommendations',
      headers: ['Priority', 'Related', 'Title', 'Evidence', 'Recommended action', 'Date'],
      rows: rows.map((r) => [r.priority.toUpperCase(), r.entityLabel ?? r.entityType, r.title, r.evidence.map((e) => `${e.metric}: ${e.value}`).join('; '), r.recommendedAction, r.generatedForDate]),
    },
  };
}

export async function buildReport(type: ReportType, cur: Range, prev: Range, opts: { websiteId?: string; appId?: string } = {}): Promise<ReportDoc> {
  const base = { period: cur, previousPeriod: prev, generatedAt: new Date().toISOString() };
  const sub = `${cur.start} to ${cur.end} · compared with ${prev.start} to ${prev.end}`;

  const website = async () => {
    if (!opts.websiteId) throw badRequest('websiteId is required for this report');
    const [w] = await db.select().from(websites).where(eq(websites.id, opts.websiteId));
    if (!w) throw notFound('Website');
    return w;
  };

  switch (type) {
    case 'portfolio':
    case 'monthly_executive': {
      const ov = await portfolioOverview(cur, prev);
      const seo = await seoSections(null, cur, prev, 'All websites');
      const traffic = await trafficSections(null, cur, prev, 'All websites');
      const ad = await admobSections(cur, prev);
      const vit = await vitalsSections(null, cur);
      const sites = await websiteRows(cur, prev);
      const apps = await appRows(cur, prev);
      const exec = [
        `Portfolio: ${ov.websites} website(s) and ${ov.androidApps} Android app(s) monitored.`,
        ...seo.summary,
        ...traffic.summary,
        ...ad.summary,
        ...vit.summary,
        ov.decliningWebsites.length ? `Declining websites: ${ov.decliningWebsites.map((d) => d.name).join(', ')}.` : 'No website declined by more than 10% versus the previous period.',
      ];
      return {
        ...base,
        title: type === 'monthly_executive' ? 'Monthly Executive Report' : 'Complete Portfolio Report',
        subtitle: sub,
        sources: ['Google Search Console', 'Google Analytics 4', 'Google AdMob', 'Google Play Developer Reporting'],
        executiveSummary: exec,
        sections: [
          {
            title: 'Websites',
            table: {
              title: 'Website comparison',
              headers: ['Website', 'Clicks', 'Clicks chg', 'Impressions', 'CTR', 'Avg pos', 'Sessions', 'Sess. chg', 'SEO health'],
              rows: sites.map((s) => [s.name, s.clicks, chg(s.clicksChangePct) ?? '—', s.impressions, pct(s.ctr), s.position?.toFixed(1) ?? '—', s.sessions, chg(s.sessionsChangePct) ?? '—', s.seoHealth ?? '—']),
            },
          },
          ...seo.sections.slice(0, 1),
          ...traffic.sections.slice(0, 2),
          {
            title: 'Android applications',
            table: {
              title: 'Applications',
              headers: ['App', 'Package', 'Health', 'Crash %', 'ANR %', 'Est. earnings'],
              rows: apps.map((a) => [a.name, a.packageName, a.health.replace('_', ' '), a.crashRate?.toFixed(2) ?? '—', a.anrRate?.toFixed(2) ?? '—', a.earnings.map((e) => money(e.earnings, e.currency)).join(', ') || '—']),
            },
          },
          ...ad.sections,
          ...vit.sections,
          await aiSection(cur),
        ],
      };
    }
    case 'website_seo': {
      const w = await website();
      const seo = await seoSections(w.searchConsolePropertyId ? [w.searchConsolePropertyId] : [], cur, prev, w.name);
      return { ...base, title: `SEO Report — ${w.name}`, subtitle: sub, sources: ['Google Search Console'], executiveSummary: seo.summary, sections: [...seo.sections, await aiSection(cur, { type: 'website', id: w.id })] };
    }
    case 'website_traffic': {
      const w = await website();
      const t = await trafficSections(w.ga4PropertyId ? [w.ga4PropertyId] : [], cur, prev, w.name);
      return { ...base, title: `Traffic Report — ${w.name}`, subtitle: sub, sources: ['Google Analytics 4'], executiveSummary: t.summary, sections: t.sections };
    }
    case 'keywords':
    case 'pages': {
      const w = opts.websiteId ? await website() : null;
      const ids = w ? (w.searchConsolePropertyId ? [w.searchConsolePropertyId] : []) : null;
      const kind = type === 'keywords' ? 'query' : 'page';
      const t = await dimensionTable(kind, ids, cur, prev, { limit: 1000 });
      const label = type === 'keywords' ? 'Keyword' : 'Page';
      return {
        ...base,
        title: `${label} Performance Report${w ? ` — ${w.name}` : ''}`,
        subtitle: sub,
        sources: ['Google Search Console'],
        executiveSummary: [`${t.total.toLocaleString()} ${label.toLowerCase()}s with data in the period. Positions are period averages, not exact daily rankings.`],
        sections: [
          {
            title: `${label}s`,
            table: {
              title: `${label} table`,
              headers: [label, 'Clicks', 'Prev clicks', 'Impressions', 'CTR', 'Avg pos', 'Prev pos', 'Pos chg', 'Signals'],
              rows: t.rows.map((r) => [r.key, r.clicks, r.prevClicks, r.impressions, pct(r.ctr), r.position?.toFixed(1) ?? '—', r.prevPosition?.toFixed(1) ?? '—', r.positionChange?.toFixed(1) ?? '—', r.flags.join(', ')]),
            },
          },
        ],
      };
    }
    case 'android_app': {
      if (!opts.appId) throw badRequest('appId is required');
      const [a] = await db.select().from(androidApps).where(eq(androidApps.id, opts.appId));
      if (!a) throw notFound('Android app');
      const [am] = a.admobAppId ? await db.select().from(admobApps).where(eq(admobApps.id, a.admobAppId)) : [];
      const vit = a.playConsoleAppId ? await vitalsSections([a.playConsoleAppId], cur) : { sections: [{ title: 'Android vitals', note: 'Play Developer Reporting is not linked to this app.' }], summary: [] };
      const traffic = a.ga4PropertyId ? await trafficSections([a.ga4PropertyId], cur, prev, a.name) : { sections: [{ title: 'App analytics', note: 'No GA4/Firebase property linked.' }], summary: [] };
      const ad = am ? await admobSections(cur, prev, [am.appId]) : { sections: [{ title: 'AdMob', note: 'No AdMob app linked.' }], summary: [] };
      return {
        ...base,
        title: `Android App Report — ${a.name}`,
        subtitle: `${a.packageName} · ${sub}`,
        sources: ['Google Play Developer Reporting', 'Google Analytics 4 / Firebase', 'Google AdMob'],
        executiveSummary: [...vit.summary, ...traffic.summary, ...ad.summary],
        sections: [...vit.sections, ...traffic.sections, ...ad.sections, await aiSection(cur, { type: 'android_app', id: a.id })],
      };
    }
    case 'play_health': {
      const v = await vitalsSections(null, cur);
      return { ...base, title: 'Google Play Health Report', subtitle: sub, sources: ['Google Play Developer Reporting'], executiveSummary: v.summary, sections: v.sections };
    }
    case 'admob': {
      const ad = await admobSections(cur, prev);
      return { ...base, title: 'AdMob Revenue Report', subtitle: sub, sources: ['Google AdMob Network Report'], executiveSummary: ad.summary, sections: ad.sections };
    }
    case 'ai_recommendations': {
      const sec = await aiSection(cur);
      return { ...base, title: 'AI Recommendations Report', subtitle: sub, sources: ['DP360 AI analysis of stored data'], executiveSummary: [`${sec.table?.rows.length ?? 0} active recommendation(s) in the period.`], sections: [sec] };
    }
  }
}
