/**
 * Growth intelligence: standard web/SEO/app/ad-monetisation formulas computed
 * from stored data only. Every estimate is labelled as an estimate.
 */
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { websites, androidApps, admobApps, aiInsights } from '../../db/schema.js';
import { addDays, diffDays, monthStart, pctChange, todayIn, type Range } from '../../lib/dates.js';
import { getSettings } from '../settings.js';
import { seoTotals, seoTimeseries, dimensionTable, breakdown, ga4Totals, ga4Timeseries, admobTotals, admobGrouped, vitalsSummary, classifyHealth } from '../metrics.js';
import type { ReportAction, ReportCallout, ReportDefinition, ReportSection } from './builder.js';

/* ------------------------------ formulas ------------------------------ */

/**
 * Organic CTR benchmark by average position (approximation of public organic
 * CTR studies, desktop+mobile blended). Used only to size opportunities.
 */
const CTR_CURVE = [0.284, 0.157, 0.11, 0.08, 0.072, 0.051, 0.04, 0.032, 0.028, 0.025];
export function expectedCtr(position: number | null | undefined): number | null {
  if (position == null || position <= 0) return null;
  if (position <= 1) return CTR_CURVE[0];
  if (position <= 10) {
    const lo = Math.floor(position);
    const hi = Math.min(10, lo + 1);
    const t = position - lo;
    return CTR_CURVE[lo - 1] * (1 - t) + CTR_CURVE[hi - 1] * t;
  }
  if (position <= 20) return 0.012;
  return 0.004;
}

export type Trend = 'growing' | 'stable' | 'declining' | 'new' | 'no_data';
export function trendOf(changePct: number | null, current: number | null): Trend {
  if (current == null) return 'no_data';
  if (changePct == null) return current > 0 ? 'new' : 'no_data';
  if (changePct >= 5) return 'growing';
  if (changePct <= -5) return 'declining';
  return 'stable';
}
const TREND_LABEL: Record<Trend, string> = { growing: '▲ Growing', stable: '► Stable', declining: '▼ Declining', new: '● New', no_data: '—' };

export const DEFINITIONS: ReportDefinition[] = [
  { term: 'CTR', formula: 'Clicks ÷ Impressions × 100', meaning: 'Share of searchers who clicked your result.' },
  { term: 'Average position', formula: 'Σ(position × impressions) ÷ Σ impressions', meaning: 'Impression-weighted average ranking over the period (not an exact daily rank).' },
  { term: 'Expected CTR', formula: 'Benchmark CTR for the average position', meaning: 'Typical organic CTR at that position (public CTR studies, approximate).' },
  { term: 'CTR gap', formula: 'Expected CTR − Actual CTR', meaning: 'Positive gap = title/description likely under-performing.' },
  { term: 'Click potential', formula: 'Impressions × max(0, Target CTR − Actual CTR)', meaning: 'Estimated extra clicks if CTR reached the target (estimate, not a promise).' },
  { term: 'Striking-distance keyword', formula: 'Average position 4–20 with meaningful impressions', meaning: 'Closest wins: small ranking gains move these onto page 1 / top 3.' },
  { term: 'Growth %', formula: '(Current − Previous) ÷ Previous × 100', meaning: 'Change versus the comparison period of equal length.' },
  { term: 'Traffic share', formula: 'Site clicks ÷ Portfolio clicks × 100', meaning: 'How much of total search traffic each site contributes.' },
  { term: 'Engagement rate', formula: 'Engaged sessions ÷ Sessions × 100', meaning: 'GA4: sessions lasting >10s, with a key event or 2+ page views.' },
  { term: 'Conversion rate', formula: 'Key events ÷ Sessions × 100', meaning: 'How often a visit produces a key event (GA4 conversions).' },
  { term: 'Average DAU', formula: 'Σ daily active users ÷ days', meaning: 'Average daily active users for an app.' },
  { term: 'Crash-free users', formula: '100 − Crash rate', meaning: 'Share of daily users who did not experience a crash.' },
  { term: 'eCPM', formula: 'Estimated earnings ÷ Impressions × 1000', meaning: 'Earnings per thousand ad impressions.' },
  { term: 'Match rate', formula: 'Matched requests ÷ Ad requests × 100', meaning: 'Fill: how many ad requests received an ad.' },
  { term: 'Show rate', formula: 'Impressions ÷ Matched requests × 100', meaning: 'How many filled ads were actually shown.' },
  { term: 'ARPDAU', formula: 'Ad earnings ÷ Σ daily active users', meaning: 'Average ad revenue per daily active user.' },
  { term: 'Month-end projection', formula: 'Month-to-date earnings ÷ days elapsed × days in month', meaning: 'Simple run-rate forecast; actual results will differ.' },
  { term: 'Revenue concentration', formula: 'Top item earnings ÷ Total earnings × 100', meaning: 'Dependence on a single app / country (risk indicator).' },
];

const n0 = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));
const n2 = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }));
const pct = (v: number | null | undefined, d = 2) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const pp = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v.toFixed(d)}%`);
const chg = (v: number | null | undefined) => (v == null ? '—' : Math.abs(v) < 0.05 ? '0.0%' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const money = (v: number | null | undefined, c: string) => (v == null ? '—' : `${c} ${n2(v)}`);
const safe = (a: number | null | undefined, b: number | null | undefined) => (a == null || !b ? null : a / b);

/* ------------------------------ data gathering ------------------------------ */

export interface SiteStats {
  id: string;
  name: string;
  domain: string;
  hasSc: boolean;
  hasGa: boolean;
  clicks: number | null;
  prevClicks: number | null;
  impressions: number | null;
  prevImpressions: number | null;
  ctr: number | null;
  position: number | null;
  prevPosition: number | null;
  sessions: number | null;
  prevSessions: number | null;
  users: number | null;
  engagementRate: number | null;
  keyEvents: number | null;
  clicksChange: number | null;
  sessionsChange: number | null;
  trend: Trend;
  expectedCtr: number | null;
  freshDays: number;
}

export async function siteStats(cur: Range, prev: Range, websiteId?: string): Promise<SiteStats[]> {
  const list = websiteId ? await db.select().from(websites).where(eq(websites.id, websiteId)) : await db.select().from(websites).where(eq(websites.isMonitored, true));
  return Promise.all(
    list.map(async (w) => {
      const sc = w.searchConsolePropertyId ? [w.searchConsolePropertyId] : [];
      const ga = w.ga4PropertyId ? [w.ga4PropertyId] : [];
      const [c, p, gc, gp] = await Promise.all([seoTotals(sc, cur), seoTotals(sc, prev), ga4Totals(ga, cur), ga4Totals(ga, prev)]);
      const clicksChange = pctChange(c.clicks, p.clicks);
      const sessionsChange = pctChange(gc.sessions, gp.sessions);
      return {
        id: w.id,
        name: w.name,
        domain: w.domain,
        hasSc: sc.length > 0,
        hasGa: ga.length > 0,
        clicks: c.clicks,
        prevClicks: p.clicks,
        impressions: c.impressions,
        prevImpressions: p.impressions,
        ctr: c.ctr,
        position: c.position,
        prevPosition: p.position,
        sessions: gc.sessions,
        prevSessions: gp.sessions,
        users: gc.activeUsersDailySum,
        engagementRate: gc.engagementRate,
        keyEvents: gc.keyEvents,
        clicksChange,
        sessionsChange,
        trend: trendOf(clicksChange ?? sessionsChange, c.clicks ?? gc.sessions),
        expectedCtr: expectedCtr(c.position),
        freshDays: c.freshDays,
      };
    }),
  );
}

export interface Opportunity {
  site: string;
  key: string;
  impressions: number;
  ctr: number;
  position: number;
  potential: number;
  detail: string;
}

/** Striking distance (pos 4–20) and low-CTR items, sized with the CTR benchmark. */
export async function opportunities(cur: Range, prev: Range, sites: SiteStats[]) {
  const striking: Opportunity[] = [];
  const lowCtrPages: Opportunity[] = [];
  const decliningPages: Array<{ site: string; key: string; clicks: number; prevClicks: number; lost: number; position: number | null; prevPosition: number | null }> = [];
  const risingKeywords: Array<{ site: string; key: string; impressions: number; prevImpressions: number; position: number | null }> = [];
  for (const s of sites.filter((x) => x.hasSc)) {
    const [w] = await db.select().from(websites).where(eq(websites.id, s.id));
    const ids = [w.searchConsolePropertyId!];
    const [kw, pages, losing, gaining] = await Promise.all([
      dimensionTable('query', ids, cur, prev, { filter: 'opportunity', sort: 'impressions', limit: 300 }),
      dimensionTable('page', ids, cur, prev, { sort: 'impressions', limit: 300 }),
      dimensionTable('page', ids, cur, prev, { filter: 'losing_clicks', sort: 'click_change', dir: 'asc', limit: 15 }),
      dimensionTable('query', ids, cur, prev, { filter: 'gaining_impressions', sort: 'impression_change', limit: 15 }),
    ]);
    const target = expectedCtr(3)!;
    for (const r of kw.rows) {
      if (r.position == null || r.ctr == null || !r.impressions) continue;
      const potential = r.impressions * Math.max(0, target - r.ctr);
      if (potential < 1) continue;
      striking.push({ site: s.name, key: r.key, impressions: r.impressions, ctr: r.ctr, position: r.position, potential, detail: `pos ${r.position.toFixed(1)} → 3` });
    }
    for (const r of pages.rows) {
      if (r.position == null || r.ctr == null || !r.impressions || r.impressions < 100) continue;
      const exp = expectedCtr(r.position);
      if (exp == null || r.ctr >= exp * 0.6) continue;
      const potential = r.impressions * (exp - r.ctr);
      if (potential < 1) continue;
      lowCtrPages.push({ site: s.name, key: r.key, impressions: r.impressions, ctr: r.ctr, position: r.position, potential, detail: `expected ${pct(exp, 1)}` });
    }
    for (const r of losing.rows) {
      if (r.prevClicks == null || r.clicks == null) continue;
      decliningPages.push({ site: s.name, key: r.key, clicks: r.clicks, prevClicks: r.prevClicks, lost: r.prevClicks - r.clicks, position: r.position, prevPosition: r.prevPosition });
    }
    for (const r of gaining.rows) {
      risingKeywords.push({ site: s.name, key: r.key, impressions: r.impressions ?? 0, prevImpressions: r.prevImpressions ?? 0, position: r.position });
    }
  }
  striking.sort((a, b) => b.potential - a.potential);
  lowCtrPages.sort((a, b) => b.potential - a.potential);
  decliningPages.sort((a, b) => b.lost - a.lost);
  risingKeywords.sort((a, b) => b.impressions - b.prevImpressions - (a.impressions - a.prevImpressions));
  return { striking, lowCtrPages, decliningPages, risingKeywords };
}

export interface AppStats {
  id: string;
  name: string;
  packageName: string;
  avgDau: number | null;
  dauSum: number | null;
  days: number;
  crashRate: number | null;
  anrRate: number | null;
  health: string;
  earnings: number | null;
  prevEarnings: number | null;
  currency: string | null;
  impressions: number | null;
  ecpm: number | null;
  matchRate: number | null;
  arpdau: number | null;
  impressionsPerDau: number | null;
}

export async function appStats(cur: Range, prev: Range, appId?: string): Promise<AppStats[]> {
  const s = await getSettings();
  const list = appId ? await db.select().from(androidApps).where(eq(androidApps.id, appId)) : await db.select().from(androidApps).where(eq(androidApps.isMonitored, true));
  return Promise.all(
    list.map(async (a) => {
      const [am] = a.admobAppId ? await db.select().from(admobApps).where(eq(admobApps.id, a.admobAppId)) : [];
      const ga = a.ga4PropertyId ? await ga4Totals([a.ga4PropertyId], cur) : null;
      const vit = a.playConsoleAppId ? await vitalsSummary([a.playConsoleAppId], cur) : [];
      const crash = vit.find((v) => v.metric === 'crashRate' && !v.slice)?.value ?? null;
      const anr = vit.find((v) => v.metric === 'anrRate' && !v.slice)?.value ?? null;
      const [rev] = am ? await admobTotals(cur, [am.appId]) : [];
      const [prevRev] = am ? await admobTotals(prev, [am.appId]) : [];
      const dauSum = ga?.activeUsersDailySum ?? null;
      const days = ga?.days ?? 0;
      return {
        id: a.id,
        name: a.name,
        packageName: a.packageName,
        avgDau: dauSum != null && days ? dauSum / days : null,
        dauSum,
        days,
        crashRate: crash,
        anrRate: anr,
        health: a.playConsoleAppId ? classifyHealth(crash, anr, s.thresholds) : 'no_data',
        earnings: rev?.earnings ?? null,
        prevEarnings: prevRev?.earnings ?? null,
        currency: rev?.currency ?? null,
        impressions: rev?.impressions ?? null,
        ecpm: rev?.ecpm ?? null,
        matchRate: rev?.matchRate ?? null,
        arpdau: safe(rev?.earnings, dauSum),
        impressionsPerDau: safe(rev?.impressions, dauSum),
      };
    }),
  );
}

/** Month-to-date run-rate projection per currency. */
export async function revenueProjection(tz: string) {
  const today = todayIn(tz);
  const start = monthStart(today);
  const yesterday = addDays(today, -1);
  if (yesterday < start) return [];
  const mtd = await admobTotals({ start, end: yesterday });
  const elapsed = diffDays(start, yesterday) + 1;
  const [y, m] = today.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return mtd.map((t) => ({ currency: t.currency, mtd: t.earnings, elapsed, daysInMonth, projected: t.earnings != null ? (t.earnings / elapsed) * daysInMonth : null, through: yesterday }));
}

/* ------------------------------ section builders ------------------------------ */

export async function growthSections(cur: Range, prev: Range, opts: { websiteId?: string; appId?: string; includeApps?: boolean; includeRevenue?: boolean; skipWebsites?: boolean } = {}) {
  const s = await getSettings();
  const t = s.thresholds;
  const sections: ReportSection[] = [];
  const actions: ReportAction[] = [];
  const summary: string[] = [];

  /* ---------- websites scorecard ---------- */
  const sites = opts.appId || opts.skipWebsites ? [] : await siteStats(cur, prev, opts.websiteId);
  if (sites.length) {
    const totalClicks = sites.reduce((a, x) => a + (x.clicks ?? 0), 0);
    const totalPrev = sites.reduce((a, x) => a + (x.prevClicks ?? 0), 0);
    const totalSessions = sites.reduce((a, x) => a + (x.sessions ?? 0), 0);
    const portfolioChange = pctChange(totalClicks, totalPrev);
    const growing = sites.filter((x) => x.trend === 'growing');
    const declining = sites.filter((x) => x.trend === 'declining');
    summary.push(
      `Search: ${n0(totalClicks)} clicks across ${sites.filter((x) => x.hasSc).length} site(s) (${chg(portfolioChange)} vs previous period); ${growing.length} growing, ${declining.length} declining.`,
    );
    if (totalSessions) summary.push(`Traffic: ${n0(totalSessions)} sessions recorded in GA4.`);
    const callouts: ReportCallout[] = [];
    const best = [...sites].filter((x) => x.clicksChange != null).sort((a, b) => (b.clicksChange ?? 0) - (a.clicksChange ?? 0));
    if (best[0] && (best[0].clicksChange ?? 0) > 0) callouts.push({ tone: 'good', text: `Fastest growing: ${best[0].name} (${chg(best[0].clicksChange)} clicks).` });
    const worst = best[best.length - 1];
    if (worst && (worst.clicksChange ?? 0) < -5) callouts.push({ tone: 'bad', text: `Biggest decline: ${worst.name} (${chg(worst.clicksChange)} clicks).` });
    const noGa = sites.filter((x) => !x.hasGa);
    const noSc = sites.filter((x) => !x.hasSc);
    if (noGa.length) callouts.push({ tone: 'info', text: `${noGa.length} site(s) have no GA4 property linked (${noGa.map((x) => x.name).join(', ')}) — traffic and conversions are missing for them.` });
    if (noSc.length) callouts.push({ tone: 'info', text: `${noSc.length} site(s) have no Search Console property linked (${noSc.map((x) => x.name).join(', ')}).` });
    if (sites.some((x) => x.freshDays)) callouts.push({ tone: 'info', text: 'The most recent day(s) contain preliminary Search Console data that may still change.' });

    sections.push({
      title: 'Website scorecard',
      note: 'Growth status uses search clicks (or sessions when Search Console is not linked): ▲ ≥ +5%, ▼ ≤ −5%.',
      callouts,
      table: {
        title: 'Websites',
        headers: ['Website', 'Status', 'Clicks', 'Clicks chg', 'Share', 'Impr.', 'CTR', 'Exp. CTR', 'Avg pos', 'Pos chg', 'Sessions', 'Sess. chg', 'Engage.', 'Conv. rate'],
        rows: [...sites]
          .sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1))
          .map((x) => [
            x.name,
            TREND_LABEL[x.trend],
            n0(x.clicks),
            chg(x.clicksChange),
            totalClicks && x.clicks != null ? pp((x.clicks / totalClicks) * 100) : '—',
            n0(x.impressions),
            pct(x.ctr),
            pct(x.expectedCtr, 1),
            x.position?.toFixed(1) ?? '—',
            x.position != null && x.prevPosition != null ? `${(x.prevPosition - x.position) >= 0 ? '+' : ''}${(x.prevPosition - x.position).toFixed(1)}` : '—',
            n0(x.sessions),
            chg(x.sessionsChange),
            pct(x.engagementRate, 1),
            x.sessions ? pct(safe(x.keyEvents, x.sessions), 2) : '—',
          ]),
      },
    });

    for (const x of sites) {
      if (x.clicksChange != null && (x.prevClicks ?? 0) >= t.minClicksForAlert && x.clicksChange <= -t.trafficDeclinePct) {
        actions.push({ priority: x.clicksChange <= -50 ? 'critical' : 'high', area: x.name, action: 'Investigate the search traffic drop: compare top pages and queries, check indexing and recent site changes.', evidence: `Clicks ${n0(x.prevClicks)} → ${n0(x.clicks)} (${chg(x.clicksChange)})`, impact: `Recover up to ${n0((x.prevClicks ?? 0) - (x.clicks ?? 0))} clicks/period` });
      }
      if (x.ctr != null && x.expectedCtr != null && x.impressions && x.ctr < x.expectedCtr * 0.6) {
        actions.push({ priority: 'medium', area: x.name, action: 'Site-wide CTR is well below benchmark for its average position — rewrite titles/meta descriptions of top pages; add structured data.', evidence: `CTR ${pct(x.ctr)} vs expected ${pct(x.expectedCtr, 1)} at pos ${x.position?.toFixed(1)}`, impact: `≈${n0(x.impressions * (x.expectedCtr - x.ctr))} extra clicks if CTR reached benchmark (estimate)` });
      }
    }

    /* ---------- trend chart ---------- */
    const allSc = sites.filter((x) => x.hasSc).length ? await seoTimeseries(opts.websiteId ? (await db.select().from(websites).where(eq(websites.id, opts.websiteId))).map((w) => w.searchConsolePropertyId!).filter(Boolean) : null, cur) : [];
    if (allSc.length) sections.push({ title: 'Search trend', chart: { type: 'line', title: 'Daily search clicks', labels: allSc.map((d) => d.date), series: [{ name: 'Clicks', values: allSc.map((d) => d.clicks) }] } });

    /* ---------- opportunities ---------- */
    const opp = await opportunities(cur, prev, sites);
    const strikingTotal = opp.striking.reduce((a, x) => a + x.potential, 0);
    const lowCtrTotal = opp.lowCtrPages.reduce((a, x) => a + x.potential, 0);
    if (opp.striking.length || opp.lowCtrPages.length) {
      summary.push(`Opportunity: ≈${n0(strikingTotal + lowCtrTotal)} additional clicks per period are estimated from ${opp.striking.length} striking-distance keyword(s) and ${opp.lowCtrPages.length} low-CTR page(s).`);
    }
    sections.push({
      title: 'Growth opportunities — striking-distance keywords',
      note: `Keywords at average position 4–20. Click potential = impressions × (benchmark CTR at position 3 ≈ ${pct(expectedCtr(3), 1)} − current CTR). Estimates, not guarantees.`,
      table: {
        title: 'Striking-distance keywords',
        headers: ['Website', 'Keyword', 'Impressions', 'CTR', 'Avg pos', 'Est. extra clicks'],
        rows: opp.striking.slice(0, 25).map((o) => [o.site, o.key, n0(o.impressions), pct(o.ctr), o.position.toFixed(1), n0(o.potential)]),
      },
    });
    for (const o of opp.striking.slice(0, 5)) {
      actions.push({ priority: o.potential >= 100 ? 'high' : 'medium', area: o.site, action: `Improve ranking for “${o.key}”: expand the ranking page’s content for this intent, add internal links with this anchor, refresh the title.`, evidence: `${n0(o.impressions)} impressions at pos ${o.position.toFixed(1)}, CTR ${pct(o.ctr)}`, impact: `≈${n0(o.potential)} extra clicks if it reached position 3 (estimate)` });
    }
    sections.push({
      title: 'Growth opportunities — pages with low CTR',
      note: 'Pages whose CTR is below 60% of the benchmark for their average position. Usually fixed by better titles, meta descriptions and rich results.',
      table: {
        title: 'Low-CTR pages',
        headers: ['Website', 'Page', 'Impressions', 'CTR', 'Expected CTR', 'Avg pos', 'Est. extra clicks'],
        rows: opp.lowCtrPages.slice(0, 25).map((o) => [o.site, o.key, n0(o.impressions), pct(o.ctr), o.detail.replace('expected ', ''), o.position.toFixed(1), n0(o.potential)]),
      },
    });
    for (const o of opp.lowCtrPages.slice(0, 3)) {
      actions.push({ priority: 'medium', area: o.site, action: `Rewrite the title & meta description of ${o.key.replace(/^https?:\/\/[^/]+/, '') || '/'} to match search intent; consider FAQ/HowTo structured data.`, evidence: `CTR ${pct(o.ctr)} vs ${o.detail} at pos ${o.position.toFixed(1)}`, impact: `≈${n0(o.potential)} extra clicks (estimate)` });
    }
    sections.push({
      title: 'Content decay — pages losing clicks',
      note: 'Pages with ≥5 previous clicks that lost at least 20% versus the previous period.',
      table: {
        title: 'Declining pages',
        headers: ['Website', 'Page', 'Prev clicks', 'Clicks', 'Lost', 'Prev pos', 'Pos'],
        rows: opp.decliningPages.slice(0, 20).map((d) => [d.site, d.key, n0(d.prevClicks), n0(d.clicks), n0(d.lost), d.prevPosition?.toFixed(1) ?? '—', d.position?.toFixed(1) ?? '—']),
      },
    });
    for (const d of opp.decliningPages.slice(0, 3)) {
      actions.push({ priority: d.lost >= 50 ? 'high' : 'medium', area: d.site, action: `Refresh ${d.key.replace(/^https?:\/\/[^/]+/, '') || '/'}: update facts/dates, cover missing sub-topics, check it is still indexed (Indexing Monitor).`, evidence: `Clicks ${n0(d.prevClicks)} → ${n0(d.clicks)}${d.prevPosition != null && d.position != null ? `, pos ${d.prevPosition.toFixed(1)} → ${d.position.toFixed(1)}` : ''}`, impact: `Recover up to ${n0(d.lost)} clicks/period` });
    }
    if (opp.risingKeywords.length) {
      sections.push({
        title: 'Rising demand — keywords gaining impressions',
        note: 'Topics where Google is showing you more often; create or strengthen content to capture them.',
        table: {
          title: 'Rising keywords',
          headers: ['Website', 'Keyword', 'Prev impressions', 'Impressions', 'Avg pos'],
          rows: opp.risingKeywords.slice(0, 15).map((r) => [r.site, r.key, n0(r.prevImpressions), n0(r.impressions), r.position?.toFixed(1) ?? '—']),
        },
      });
    }

    /* ---------- traffic quality ---------- */
    const gaIds = opts.websiteId ? (await db.select().from(websites).where(eq(websites.id, opts.websiteId))).map((w) => w.ga4PropertyId!).filter(Boolean) : null;
    const [channels, countries, devices] = await Promise.all([breakdown('ga4', gaIds, 'channel', cur, 12), breakdown('ga4', gaIds, 'country', cur, 10), breakdown('ga4', gaIds, 'device', cur, 4)]);
    if (channels.length) {
      const total = channels.reduce((a, c) => a + (c.sessions ?? 0), 0);
      const organic = channels.find((c) => /organic search/i.test(c.value));
      const callouts: ReportCallout[] = [];
      if (organic && total) callouts.push({ tone: 'info', text: `Organic search delivers ${pp(((organic.sessions ?? 0) / total) * 100)} of sessions.` });
      const bestConv = [...channels].filter((c) => (c.sessions ?? 0) >= 20).sort((a, b) => (safe(b.keyEvents, b.sessions) ?? 0) - (safe(a.keyEvents, a.sessions) ?? 0))[0];
      if (bestConv && safe(bestConv.keyEvents, bestConv.sessions)) callouts.push({ tone: 'good', text: `Best converting channel: ${bestConv.value} (${pct(safe(bestConv.keyEvents, bestConv.sessions))} conversion rate).` });
      sections.push({
        title: 'Traffic quality by channel',
        note: 'Source: GA4 session default channel group.',
        callouts,
        table: {
          title: 'Acquisition channels',
          headers: ['Channel', 'Sessions', 'Share', 'Active users', 'Engagement rate', 'Key events', 'Conv. rate'],
          rows: channels.map((c) => [c.value, n0(c.sessions), total ? pp(((c.sessions ?? 0) / total) * 100) : '—', n0(c.activeUsers), pct(c.engagementRate, 1), n0(c.keyEvents), pct(safe(c.keyEvents, c.sessions))]),
        },
      });
      const dTotal = devices.reduce((a, c) => a + (c.sessions ?? 0), 0);
      const cTotal = countries.reduce((a, c) => a + (c.sessions ?? 0), 0);
      sections.push({
        title: 'Audience — countries & devices',
        chart: { type: 'bar', title: 'Sessions by country', labels: countries.map((c) => c.value), series: [{ name: 'Sessions', values: countries.map((c) => c.sessions) }] },
        table: {
          title: 'Countries & devices',
          headers: ['Segment', 'Sessions', 'Share', 'Engagement rate', 'Conv. rate'],
          rows: [
            ...countries.map((c) => [`Country · ${c.value}`, n0(c.sessions), cTotal ? pp(((c.sessions ?? 0) / cTotal) * 100) : '—', pct(c.engagementRate, 1), pct(safe(c.keyEvents, c.sessions))]),
            ...devices.map((c) => [`Device · ${c.value}`, n0(c.sessions), dTotal ? pp(((c.sessions ?? 0) / dTotal) * 100) : '—', pct(c.engagementRate, 1), pct(safe(c.keyEvents, c.sessions))]),
          ],
        },
      });
      const mobile = devices.find((d) => d.value === 'mobile');
      const desktop = devices.find((d) => d.value === 'desktop');
      if (mobile?.engagementRate != null && desktop?.engagementRate != null && mobile.engagementRate < desktop.engagementRate * 0.8 && (mobile.sessions ?? 0) >= 50) {
        actions.push({ priority: 'medium', area: 'All websites', action: 'Mobile engagement is much lower than desktop — test page speed (Core Web Vitals) and mobile layout on top landing pages.', evidence: `Engagement mobile ${pct(mobile.engagementRate, 1)} vs desktop ${pct(desktop.engagementRate, 1)}`, impact: 'Higher engagement and conversions from mobile visitors' });
      }
    }
  }

  /* ---------- apps ---------- */
  if (opts.includeApps !== false && !opts.websiteId) {
    const apps = await appStats(cur, prev, opts.appId);
    if (apps.length) {
      const bad = apps.filter((a) => a.health === 'critical' || a.health === 'needs_attention');
      summary.push(`Apps: ${apps.length} monitored, ${bad.length} need technical attention.`);
      sections.push({
        title: 'Android apps — users, stability & monetisation',
        note: 'DAU from GA4/Firebase (sum of daily active users ÷ days). Crash/ANR from Play vitals (% of users, user-weighted). ARPDAU = ad earnings ÷ Σ daily active users.',
        callouts: bad.map((a) => ({ tone: 'bad' as const, text: `${a.name}: ${a.health.replace('_', ' ')} — crash ${pp(a.crashRate, 2)}, ANR ${pp(a.anrRate, 2)} (thresholds ${t.crashRateWarning}% / ${t.anrRateWarning}%).` })),
        table: {
          title: 'Apps',
          headers: ['App', 'Health', 'Avg DAU', 'Crash-free', 'ANR', 'Est. earnings', 'Earn. chg', 'eCPM', 'Match rate', 'ARPDAU', 'Impr./DAU'],
          rows: apps.map((a) => [
            a.name,
            a.health.replace('_', ' '),
            n0(a.avgDau),
            a.crashRate != null ? pp(100 - a.crashRate, 2) : '—',
            pp(a.anrRate, 2),
            a.currency ? money(a.earnings, a.currency) : '—',
            chg(pctChange(a.earnings, a.prevEarnings)),
            a.currency ? money(a.ecpm, a.currency) : '—',
            pp(a.matchRate, 1),
            a.arpdau != null && a.currency ? `${a.currency} ${a.arpdau.toFixed(4)}` : '—',
            a.impressionsPerDau != null ? a.impressionsPerDau.toFixed(1) : '—',
          ]),
        },
      });
      for (const a of bad) {
        actions.push({ priority: a.health === 'critical' ? 'critical' : 'high', area: a.name, action: 'Fix the top crash/ANR clusters in Play Console → Android vitals and ship a patch release; bad-behaviour thresholds reduce Play visibility.', evidence: `Crash ${pp(a.crashRate, 2)}, ANR ${pp(a.anrRate, 2)}`, impact: 'Better store ranking, retention and ad revenue' });
      }
      for (const a of apps) {
        if (a.matchRate != null && a.matchRate < 70 && (a.impressions ?? 0) > 1000) {
          actions.push({ priority: 'medium', area: a.name, action: 'Low ad match rate — enable more demand (AdMob mediation / bidding partners) and review floor prices.', evidence: `Match rate ${pp(a.matchRate, 1)}`, impact: 'More filled requests → more impressions and earnings' });
        }
      }
    }
  }

  /* ---------- revenue ---------- */
  if (opts.includeRevenue !== false && !opts.websiteId) {
    const appFilter = opts.appId ? (await db.select().from(androidApps).where(eq(androidApps.id, opts.appId))).map((a) => a.admobAppId) : null;
    const amIds = appFilter?.[0] ? (await db.select().from(admobApps).where(eq(admobApps.id, appFilter[0]))).map((x) => x.appId) : opts.appId ? [] : null;
    if (amIds === null || amIds.length) {
      const [tot, prevTot, apps, countries, formats, daily, proj] = await Promise.all([
        admobTotals(cur, amIds),
        admobTotals(prev, amIds),
        admobGrouped('app', cur, amIds),
        admobGrouped('country', cur, amIds),
        admobGrouped('format', cur, amIds),
        admobGrouped('date', cur, amIds),
        opts.appId ? Promise.resolve([]) : revenueProjection(s.general.timezone),
      ]);
      for (const c of tot) {
        const p = prevTot.find((x) => x.currency === c.currency);
        const projC = proj.find((x) => x.currency === c.currency);
        const chgE = pctChange(c.earnings, p?.earnings);
        summary.push(`Revenue: ${money(c.earnings, c.currency)} estimated AdMob earnings (${chg(chgE)}), eCPM ${money(c.ecpm, c.currency)}${projC?.projected != null ? `; this month on pace for ≈${money(projC.projected, c.currency)}` : ''}.`);
        const appsC = apps.filter((a) => a.currency === c.currency);
        const ctryC = countries.filter((a) => a.currency === c.currency);
        const topApp = appsC[0];
        const topCountry = ctryC[0];
        const callouts: ReportCallout[] = [];
        if (topApp && c.earnings) {
          const share = ((topApp.earnings ?? 0) / c.earnings) * 100;
          callouts.push({ tone: share >= 70 ? 'bad' : 'info', text: `Revenue concentration: ${topApp.label} earns ${pp(share)} of revenue${share >= 70 ? ' — high dependence on one app' : ''}.` });
        }
        if (topCountry && c.earnings) callouts.push({ tone: 'info', text: `Top country: ${topCountry.key} with ${pp(((topCountry.earnings ?? 0) / c.earnings) * 100)} of revenue at eCPM ${money(topCountry.ecpm, c.currency)}.` });
        if (chgE != null && chgE <= -t.revenueDeclinePct) {
          callouts.push({ tone: 'bad', text: `Earnings fell ${chg(chgE)} versus the previous period.` });
          actions.push({ priority: chgE <= -50 ? 'critical' : 'high', area: 'AdMob', action: 'Find the revenue drop by app, country and format; check ad unit changes, policy issues and fill (match rate).', evidence: `Earnings ${money(p?.earnings, c.currency)} → ${money(c.earnings, c.currency)}`, impact: 'Restore lost revenue' });
        }
        sections.push({
          title: `Monetisation (${c.currency})`,
          note: 'AdMob earnings are estimates until finalised by Google. Values in the account’s reporting currency.',
          callouts,
          kpis: [
            { label: 'Estimated earnings', value: money(c.earnings, c.currency), change: chg(chgE) },
            { label: 'eCPM', value: money(c.ecpm, c.currency), change: chg(pctChange(c.ecpm, p?.ecpm)) },
            { label: 'Impressions', value: n0(c.impressions), change: chg(pctChange(c.impressions, p?.impressions)) },
            { label: 'Match rate', value: pp(c.matchRate, 1) },
            { label: 'Show rate', value: pp(c.showRate, 1) },
            { label: 'Ad CTR', value: pp(c.ctr, 2) },
            ...(projC
              ? [
                  { label: 'Month to date', value: money(projC.mtd, c.currency), change: `${projC.elapsed} of ${projC.daysInMonth} days` },
                  { label: 'Month-end projection', value: money(projC.projected, c.currency), change: 'run-rate estimate' },
                ]
              : []),
          ],
          chart: { type: 'line', title: 'Daily estimated earnings', labels: daily.filter((d) => d.currency === c.currency).map((d) => d.key), series: [{ name: 'Earnings', values: daily.filter((d) => d.currency === c.currency).map((d) => d.earnings) }] },
          table: {
            title: 'Revenue by app, country and format',
            headers: ['Dimension', 'Item', 'Earnings', 'Share', 'Impressions', 'eCPM', 'Match rate'],
            rows: [
              ...appsC.slice(0, 15).map((a) => ['App', a.label, n2(a.earnings), c.earnings ? pp(((a.earnings ?? 0) / c.earnings) * 100) : '—', n0(a.impressions), n2(a.ecpm), pp(a.matchRate, 1)]),
              ...ctryC.slice(0, 10).map((a) => ['Country', a.key, n2(a.earnings), c.earnings ? pp(((a.earnings ?? 0) / c.earnings) * 100) : '—', n0(a.impressions), n2(a.ecpm), pp(a.matchRate, 1)]),
              ...formats.filter((f) => f.currency === c.currency).map((a) => ['Format', a.key, n2(a.earnings), c.earnings ? pp(((a.earnings ?? 0) / c.earnings) * 100) : '—', n0(a.impressions), n2(a.ecpm), pp(a.matchRate, 1)]),
            ],
          },
        });
        const lowFmt = formats.filter((f) => f.currency === c.currency && (f.impressions ?? 0) > 1000).sort((a, b) => (a.ecpm ?? 0) - (b.ecpm ?? 0))[0];
        const highFmt = formats.filter((f) => f.currency === c.currency && (f.impressions ?? 0) > 1000).sort((a, b) => (b.ecpm ?? 0) - (a.ecpm ?? 0))[0];
        if (lowFmt && highFmt && lowFmt.key !== highFmt.key && (highFmt.ecpm ?? 0) > (lowFmt.ecpm ?? 0) * 3) {
          actions.push({ priority: 'low', area: 'AdMob', action: `Test shifting inventory toward ${highFmt.key.toLowerCase()} placements (e.g. rewarded at natural breaks) where it fits the user experience.`, evidence: `eCPM ${highFmt.key} ${money(highFmt.ecpm, c.currency)} vs ${lowFmt.key} ${money(lowFmt.ecpm, c.currency)}`, impact: 'Higher revenue per user (validate with an A/B test)' });
        }
      }
      if (!tot.length) sections.push({ title: 'Monetisation', note: 'No AdMob data stored for this period.' });
    }
  }

  return { sections, actions, summary };
}

export async function aiActions(cur: Range, entity?: { type: string; id: string }): Promise<ReportAction[]> {
  const conds = [gte(aiInsights.generatedForDate, cur.start), lte(aiInsights.generatedForDate, cur.end), eq(aiInsights.isDismissed, false)];
  if (entity) conds.push(eq(aiInsights.entityType, entity.type), eq(aiInsights.entityId, entity.id));
  const rows = await db.select().from(aiInsights).where(and(...conds)).orderBy(desc(aiInsights.generatedForDate)).limit(30);
  const seen = new Set<string>();
  return rows
    .filter((r) => r.category !== 'positive' && !seen.has(r.title) && seen.add(r.title))
    .map((r) => ({
      priority: r.priority as ReportAction['priority'],
      area: r.entityLabel ?? r.entityType,
      action: r.recommendedAction,
      evidence: r.evidence.map((e) => `${e.metric}: ${e.value}`).join('; ') || r.problem,
      impact: r.potentialImpact ?? '—',
      source: 'AI',
    }));
}

export function sortActions(list: ReportAction[]) {
  const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return [...list].sort((a, b) => order[a.priority] - order[b.priority]);
}
