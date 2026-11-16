import OpenAI from 'openai';
import pLimit from 'p-limit';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { aiInsights, websites, androidApps, playConsoleApps, admobApps, sitemapRecords } from '../db/schema.js';
import { env } from '../config/env.js';
import { AppError } from '../lib/http.js';
import { addDays, pctChange, resolveRange, todayIn, type Preset, type Range } from '../lib/dates.js';
import { errorMessage, logger } from '../lib/logger.js';
import { getSettings } from './settings.js';
import { seoTotals, ga4Totals, dimensionTable, breakdown, admobTotals, admobGrouped, vitalsSummary, classifyHealth } from './metrics.js';
import { portfolioOverview } from './portfolio.js';

function client() {
  if (!env.OPENAI_API_KEY) throw Object.assign(new AppError(409, 'ai_not_configured', 'OPENAI_API_KEY is not configured on the backend'), { nonRetryable: true });
  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
}

export const aiConfigured = () => Boolean(env.OPENAI_API_KEY);

const recSchema = z.object({
  recommendations: z
    .array(
      z.object({
        title: z.string(),
        problem: z.string(),
        evidence: z.array(z.object({ metric: z.string(), value: z.string(), period: z.string().optional() })).default([]),
        recommended_action: z.string(),
        priority: z.enum(['critical', 'high', 'medium', 'low']),
        potential_impact: z.string().optional(),
        category: z.enum(['improvement', 'decline', 'attention', 'positive']).optional(),
      }),
    )
    .max(8),
});

const SYSTEM_RECS = `You are a senior SEO, product-analytics and mobile-monetisation analyst.
You receive a JSON evidence pack computed from the user's own stored Google data.
Rules:
- Use ONLY numbers present in the evidence. Never invent metrics, URLs, keywords or values.
- If evidence is missing or insufficient for a topic, do not speculate about it.
- Every recommendation must cite the specific evidence metrics it is based on (metric, value, period).
- Never promise or guarantee rankings, traffic or earnings; describe potential impact qualitatively.
- Search Console positions are period averages, not exact daily rankings.
- AdMob earnings are estimates until finalised by Google.
- Include positive developments as category "positive" with priority "low".
Return JSON: {"recommendations":[{"title","problem","evidence":[{"metric","value","period"}],"recommended_action","priority":"critical|high|medium|low","potential_impact","category":"improvement|decline|attention|positive"}]} with at most 6 items.`;

const r1 = (n: number | null | undefined, d = 1) => (n == null ? null : Number(n.toFixed(d)));

/* ---------------- evidence builders (DB only) ---------------- */

export async function websiteEvidence(websiteId: string, end: string) {
  const [w] = await db.select().from(websites).where(eq(websites.id, websiteId));
  if (!w) return null;
  const cur: Range = { start: addDays(end, -6), end };
  const prev: Range = { start: addDays(end, -13), end: addDays(end, -7) };
  const ev: Record<string, unknown> = { website: w.name, domain: w.domain, current_period: cur, previous_period: prev };
  if (w.searchConsolePropertyId) {
    const ids = [w.searchConsolePropertyId];
    const [c, p] = await Promise.all([seoTotals(ids, cur), seoTotals(ids, prev)]);
    ev.search_console = {
      current: { clicks: c.clicks, impressions: c.impressions, ctr_pct: r1((c.ctr ?? 0) * 100, 2), avg_position: r1(c.position) },
      previous: { clicks: p.clicks, impressions: p.impressions, ctr_pct: r1((p.ctr ?? 0) * 100, 2), avg_position: r1(p.position) },
      clicks_change_pct: r1(pctChange(c.clicks, p.clicks)),
      impressions_change_pct: r1(pctChange(c.impressions, p.impressions)),
      preliminary_days_in_current: c.freshDays,
    };
    const slim = (rows: Awaited<ReturnType<typeof dimensionTable>>['rows']) =>
      rows.map((r) => ({ key: r.key, clicks: r.clicks, prev_clicks: r.prevClicks, impressions: r.impressions, ctr_pct: r1((r.ctr ?? 0) * 100, 2), position: r1(r.position), prev_position: r1(r.prevPosition) }));
    const [gainKw, loseKw, upKw, downKw, lowCtrPages, losingPages] = await Promise.all([
      dimensionTable('query', ids, cur, prev, { filter: 'gaining_impressions', sort: 'impression_change', limit: 5 }),
      dimensionTable('query', ids, cur, prev, { filter: 'losing_clicks', sort: 'click_change', dir: 'asc', limit: 5 }),
      dimensionTable('query', ids, cur, prev, { filter: 'improving', sort: 'impressions', limit: 5 }),
      dimensionTable('query', ids, cur, prev, { filter: 'declining', sort: 'impressions', limit: 5 }),
      dimensionTable('page', ids, cur, prev, { filter: 'low_ctr', sort: 'impressions', limit: 5 }),
      dimensionTable('page', ids, cur, prev, { filter: 'losing_clicks', sort: 'click_change', dir: 'asc', limit: 5 }),
    ]);
    ev.keywords = { gaining_impressions: slim(gainKw.rows), losing_clicks: slim(loseKw.rows), improving_position: slim(upKw.rows), declining_position: slim(downKw.rows) };
    ev.pages = { high_impression_low_ctr: slim(lowCtrPages.rows), losing_clicks: slim(losingPages.rows) };
    const maps = await db.select().from(sitemapRecords).where(eq(sitemapRecords.searchConsolePropertyId, w.searchConsolePropertyId));
    ev.sitemaps = maps.map((m) => ({ path: m.path, errors: m.errors, warnings: m.warnings, last_downloaded: m.lastDownloaded }));
  } else ev.search_console = 'not connected';
  if (w.ga4PropertyId) {
    const ids = [w.ga4PropertyId];
    const [c, p, countries, channels] = await Promise.all([
      ga4Totals(ids, cur),
      ga4Totals(ids, prev),
      breakdown('ga4', ids, 'country', cur, 5),
      breakdown('ga4', ids, 'channel', cur, 8),
    ]);
    ev.ga4 = {
      current: { sessions: c.sessions, engaged_sessions: c.engagedSessions, engagement_rate_pct: r1((c.engagementRate ?? 0) * 100), key_events: c.keyEvents, page_views: c.screenPageViews, new_users: c.newUsers },
      previous: { sessions: p.sessions, engagement_rate_pct: r1((p.engagementRate ?? 0) * 100), key_events: p.keyEvents, page_views: p.screenPageViews },
      sessions_change_pct: r1(pctChange(c.sessions, p.sessions)),
      top_countries: countries.map((x) => ({ country: x.value, sessions: x.sessions })),
      channels: channels.map((x) => ({ channel: x.value, sessions: x.sessions })),
    };
  } else ev.ga4 = 'not connected';
  return ev;
}

export async function appEvidence(appId: string, end: string) {
  const [a] = await db.select().from(androidApps).where(eq(androidApps.id, appId));
  if (!a) return null;
  const s = await getSettings();
  const cur: Range = { start: addDays(end, -6), end };
  const prev: Range = { start: addDays(end, -13), end: addDays(end, -7) };
  const ev: Record<string, unknown> = { app: a.name, package: a.packageName, current_period: cur, previous_period: prev };
  if (a.playConsoleAppId) {
    const vEnd = end;
    const [vc, vp] = await Promise.all([
      vitalsSummary([a.playConsoleAppId], { start: addDays(vEnd, -9), end: addDays(vEnd, -2) }),
      vitalsSummary([a.playConsoleAppId], { start: addDays(vEnd, -16), end: addDays(vEnd, -9) }),
    ]);
    const pick = (list: typeof vc) => Object.fromEntries(list.filter((v) => !v.slice).map((v) => [v.metric, r1(v.value, 3)]));
    const curV = pick(vc);
    ev.android_vitals = {
      note: 'Rates are % of distinct users, user-weighted over the period; Play data lags ~2 days',
      current: curV,
      previous: pick(vp),
      health_status: classifyHealth((curV.crashRate as number) ?? null, (curV.anrRate as number) ?? null, s.thresholds),
      thresholds: { crash_warning: s.thresholds.crashRateWarning, anr_warning: s.thresholds.anrRateWarning },
    };
  } else ev.android_vitals = 'Play reporting not linked';
  if (a.ga4PropertyId) {
    const [c, p] = await Promise.all([ga4Totals([a.ga4PropertyId], cur), ga4Totals([a.ga4PropertyId], prev)]);
    ev.ga4 = {
      current: { sessions: c.sessions, daily_active_users_sum: c.activeUsersDailySum, engagement_rate_pct: r1((c.engagementRate ?? 0) * 100) },
      previous: { sessions: p.sessions, daily_active_users_sum: p.activeUsersDailySum, engagement_rate_pct: r1((p.engagementRate ?? 0) * 100) },
    };
  } else ev.ga4 = 'not linked';
  if (a.admobAppId) {
    const [am] = await db.select().from(admobApps).where(eq(admobApps.id, a.admobAppId));
    if (am) {
      const [c, p, fmt] = await Promise.all([admobTotals(cur, [am.appId]), admobTotals(prev, [am.appId]), admobGrouped('format', cur, [am.appId])]);
      ev.admob = {
        current: c.map((x) => ({ currency: x.currency, estimated_earnings: r1(x.earnings, 2), impressions: x.impressions, ecpm: r1(x.ecpm, 2), match_rate_pct: r1(x.matchRate) })),
        previous: p.map((x) => ({ currency: x.currency, estimated_earnings: r1(x.earnings, 2), impressions: x.impressions, ecpm: r1(x.ecpm, 2) })),
        by_format: fmt.map((x) => ({ format: x.key, earnings: r1(x.earnings, 2), ecpm: r1(x.ecpm, 2), currency: x.currency })),
      };
    }
  } else ev.admob = 'not linked';
  return ev;
}

export async function admobEvidence(end: string) {
  const cur: Range = { start: addDays(end, -6), end };
  const prev: Range = { start: addDays(end, -13), end: addDays(end, -7) };
  const [c, p, apps, countries, formats] = await Promise.all([
    admobTotals(cur),
    admobTotals(prev),
    admobGrouped('app', cur),
    admobGrouped('country', cur),
    admobGrouped('format', cur),
  ]);
  if (!c.length && !p.length) return null;
  return {
    note: 'AdMob earnings are estimated; values are in the account reporting currency',
    current_period: cur,
    previous_period: prev,
    totals_current: c.map((x) => ({ currency: x.currency, earnings: r1(x.earnings, 2), impressions: x.impressions, clicks: x.clicks, ecpm: r1(x.ecpm, 2), match_rate_pct: r1(x.matchRate), show_rate_pct: r1(x.showRate) })),
    totals_previous: p.map((x) => ({ currency: x.currency, earnings: r1(x.earnings, 2), impressions: x.impressions, ecpm: r1(x.ecpm, 2) })),
    apps: apps.slice(0, 10).map((x) => ({ app: x.label, earnings: r1(x.earnings, 2), impressions: x.impressions, ecpm: r1(x.ecpm, 2), match_rate_pct: r1(x.matchRate), currency: x.currency })),
    countries: countries.slice(0, 10).map((x) => ({ country: x.key, earnings: r1(x.earnings, 2), ecpm: r1(x.ecpm, 2), currency: x.currency })),
    formats: formats.map((x) => ({ format: x.key, earnings: r1(x.earnings, 2), ecpm: r1(x.ecpm, 2), show_rate_pct: r1(x.showRate), currency: x.currency })),
  };
}

async function recommend(evidence: unknown) {
  const ai = client();
  const res = await ai.chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_RECS },
      { role: 'user', content: JSON.stringify(evidence) },
    ],
  });
  const raw = res.choices[0]?.message?.content ?? '{}';
  const parsed = recSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('AI returned an unexpected format');
  return parsed.data.recommendations;
}

/** Generates and stores recommendations for every monitored website, app and AdMob. */
export async function runDailyAnalysis(date?: string) {
  const s = await getSettings();
  const end = date ?? addDays(todayIn(s.general.timezone), -1);
  client(); // fail fast if not configured
  const sites = await db.select().from(websites).where(eq(websites.isMonitored, true));
  const apps = await db.select().from(androidApps).where(eq(androidApps.isMonitored, true));
  const limit = pLimit(3);
  let stored = 0;
  const errors: string[] = [];

  const store = async (entityType: string, entityId: string | null, label: string, ev: unknown) => {
    if (!ev) return;
    try {
      const recs = await recommend(ev);
      await db
        .delete(aiInsights)
        .where(and(eq(aiInsights.entityType, entityType), eq(aiInsights.generatedForDate, end), entityId ? eq(aiInsights.entityId, entityId) : eq(aiInsights.entityType, entityType)));
      if (recs.length) {
        await db.insert(aiInsights).values(
          recs.map((r) => ({
            entityType,
            entityId,
            entityLabel: label,
            title: r.title,
            problem: r.problem,
            evidence: r.evidence,
            recommendedAction: r.recommended_action,
            priority: r.priority,
            potentialImpact: r.potential_impact ?? null,
            category: r.category ?? null,
            generatedForDate: end,
            model: env.OPENAI_MODEL,
          })),
        );
      }
      stored += recs.length;
    } catch (err) {
      errors.push(`${label}: ${errorMessage(err)}`);
      logger.warn({ label, err: errorMessage(err) }, 'AI analysis failed for entity');
    }
  };

  await Promise.all([
    ...sites.map((w) => limit(async () => store('website', w.id, w.name, await websiteEvidence(w.id, end)))),
    ...apps.map((a) => limit(async () => store('android_app', a.id, a.name, await appEvidence(a.id, end)))),
    limit(async () => store('admob', null, 'AdMob portfolio', await admobEvidence(end))),
  ]);
  return { date: end, stored, errors };
}

/* ---------------- chat assistant with database tools ---------------- */

const rangeParam = {
  type: 'object',
  properties: {
    preset: { type: 'string', enum: ['today', 'yesterday', 'last7', 'last28', 'last30', 'last90', 'this_month', 'last_month', 'custom'] },
    start: { type: 'string', description: 'YYYY-MM-DD when preset=custom' },
    end: { type: 'string', description: 'YYYY-MM-DD when preset=custom' },
  },
  required: ['preset'],
} as const;

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'portfolio_overview', description: 'Portfolio KPIs: search totals, website users/sessions, AdMob earnings by currency, apps requiring attention, declining websites.', parameters: { type: 'object', properties: { range: rangeParam }, required: ['range'] } } },
  { type: 'function', function: { name: 'compare_websites', description: 'Per-website clicks, impressions, CTR, position and sessions for a period, with change vs previous period.', parameters: { type: 'object', properties: { range: rangeParam }, required: ['range'] } } },
  {
    type: 'function',
    function: {
      name: 'keywords',
      description: 'Search Console keyword table vs previous period. filter: gaining_impressions | losing_clicks | improving | declining | low_ctr | opportunity | all',
      parameters: { type: 'object', properties: { range: rangeParam, website: { type: 'string', description: 'website name or domain; omit for all' }, filter: { type: 'string' }, limit: { type: 'number' } }, required: ['range'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pages',
      description: 'Search Console page table vs previous period. Same filters as keywords.',
      parameters: { type: 'object', properties: { range: rangeParam, website: { type: 'string' }, filter: { type: 'string' }, limit: { type: 'number' } }, required: ['range'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'countries',
      description: 'Top countries. source=ga4 (sessions/users) or search_console (clicks).',
      parameters: { type: 'object', properties: { range: rangeParam, source: { type: 'string', enum: ['ga4', 'search_console'] }, website: { type: 'string' } }, required: ['range', 'source'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admob',
      description: 'AdMob estimated earnings, impressions, clicks, eCPM, match rate. group_by: total | app | country | format | date | month',
      parameters: { type: 'object', properties: { range: rangeParam, group_by: { type: 'string' } }, required: ['range'] },
    },
  },
  { type: 'function', function: { name: 'app_health', description: 'Android vitals (crash rate, ANR rate, etc.) per app with health status.', parameters: { type: 'object', properties: { range: rangeParam }, required: ['range'] } } },
  { type: 'function', function: { name: 'recent_recommendations', description: 'Latest stored AI recommendations ordered by priority.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } } },
];

async function resolveWebsite(name?: string) {
  if (!name) return null;
  const all = await db.select().from(websites);
  const n = name.toLowerCase();
  return all.find((w) => w.name.toLowerCase() === n || w.domain.toLowerCase() === n) ?? all.find((w) => w.domain.toLowerCase().includes(n) || w.name.toLowerCase().includes(n)) ?? null;
}

async function runTool(name: string, args: Record<string, unknown>, tz: string) {
  const rg = (args.range as { preset: Preset; start?: string; end?: string }) ?? { preset: 'last28' };
  const { current, previous } = resolveRange(rg.preset, tz, rg);
  const meta = { period: current, comparison_period: previous };
  switch (name) {
    case 'portfolio_overview':
      return { ...meta, source: 'Stored Search Console, GA4, AdMob and Play data', data: await portfolioOverview(current, previous) };
    case 'compare_websites': {
      const sites = await db.select().from(websites).where(eq(websites.isMonitored, true));
      const rows = [];
      for (const w of sites) {
        const sc = w.searchConsolePropertyId ? [w.searchConsolePropertyId] : [];
        const ga = w.ga4PropertyId ? [w.ga4PropertyId] : [];
        const [c, p, gc, gp] = await Promise.all([seoTotals(sc, current), seoTotals(sc, previous), ga4Totals(ga, current), ga4Totals(ga, previous)]);
        rows.push({
          website: w.name,
          clicks: c.clicks,
          clicks_change_pct: r1(pctChange(c.clicks, p.clicks)),
          impressions: c.impressions,
          ctr_pct: r1((c.ctr ?? 0) * 100, 2),
          avg_position: r1(c.position),
          sessions: gc.sessions,
          sessions_change_pct: r1(pctChange(gc.sessions, gp.sessions)),
          search_console: sc.length ? 'connected' : 'not connected',
          ga4: ga.length ? 'connected' : 'not connected',
        });
      }
      return { ...meta, source: 'Search Console + GA4 (stored)', rows };
    }
    case 'keywords':
    case 'pages': {
      const w = await resolveWebsite(args.website as string | undefined);
      const ids = w ? (w.searchConsolePropertyId ? [w.searchConsolePropertyId] : []) : null;
      const t = await dimensionTable(name === 'keywords' ? 'query' : 'page', ids, current, previous, {
        filter: (args.filter as never) ?? 'all',
        limit: Math.min(Number(args.limit ?? 15), 50),
        sort: 'clicks',
      });
      return { ...meta, website: w?.name ?? 'all selected properties', source: 'Search Console (positions are period averages)', rows: t.rows };
    }
    case 'countries': {
      const w = await resolveWebsite(args.website as string | undefined);
      const src = args.source === 'search_console' ? 'search_console' : 'ga4';
      const ids = w ? [src === 'ga4' ? w.ga4PropertyId : w.searchConsolePropertyId].filter(Boolean) as string[] : null;
      return { ...meta, source: src, rows: await breakdown(src, ids, 'country', current, 15) };
    }
    case 'admob': {
      const g = String(args.group_by ?? 'total');
      const data = g === 'total' ? await admobTotals(current) : await admobGrouped(g as 'app', current);
      return { ...meta, source: 'AdMob Network Report (estimated earnings)', group_by: g, rows: data.slice(0, 40) };
    }
    case 'app_health': {
      const s = await getSettings();
      const apps = await db.select().from(playConsoleApps).where(eq(playConsoleApps.isSelected, true));
      const v = await vitalsSummary(null, current);
      return {
        ...meta,
        source: 'Play Developer Reporting API',
        rows: apps.map((a) => {
          const mine = v.filter((x) => x.appId === a.id && !x.slice);
          const crash = mine.find((x) => x.metric === 'crashRate')?.value ?? null;
          const anr = mine.find((x) => x.metric === 'anrRate')?.value ?? null;
          return { app: a.displayName ?? a.packageName, crash_rate_pct: r1(crash, 3), anr_rate_pct: r1(anr, 3), status: classifyHealth(crash, anr, s.thresholds), metrics: Object.fromEntries(mine.map((m) => [m.metric, r1(m.value, 3)])) };
        }),
      };
    }
    case 'recent_recommendations': {
      const rows = await db.select().from(aiInsights).where(eq(aiInsights.isDismissed, false)).orderBy(desc(aiInsights.generatedForDate)).limit(Math.min(Number(args.limit ?? 15), 40));
      return { source: 'Stored AI recommendations', rows: rows.map((r) => ({ title: r.title, related: r.entityLabel, priority: r.priority, action: r.recommendedAction, date: r.generatedForDate })) };
    }
    default:
      return { error: 'unknown tool' };
  }
}

export async function chat(messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
  const ai = client();
  const s = await getSettings();
  const today = todayIn(s.general.timezone);
  const convo: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are the analytics assistant inside "Digital Performance 360". Today is ${today} (${s.general.timezone}).
Answer ONLY from tool results, which read the user's stored Google Search Console, GA4, AdMob and Google Play data.
Always state the date range used and the data source(s). If data is missing or a service is not connected, say so plainly — never guess numbers.
Search Console positions are period averages. AdMob earnings are estimates; keep their original currency.
Be concise; use short bullet lists or small markdown tables when comparing.`,
    },
    ...messages.slice(-12),
  ];
  const sources = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const res = await ai.chat.completions.create({ model: env.OPENAI_MODEL, temperature: 0.2, messages: convo, tools });
    const msg = res.choices[0]?.message;
    if (!msg) break;
    if (!msg.tool_calls?.length) return { answer: msg.content ?? '', toolsUsed: [...sources] };
    convo.push(msg);
    for (const call of msg.tool_calls) {
      if (call.type !== 'function') continue;
      sources.add(call.function.name);
      let out: unknown;
      try {
        out = await runTool(call.function.name, JSON.parse(call.function.arguments || '{}'), s.general.timezone);
      } catch (err) {
        out = { error: errorMessage(err) };
      }
      convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out).slice(0, 60_000) });
    }
  }
  return { answer: 'I could not complete the analysis within the tool-call limit. Please narrow the question.', toolsUsed: [...sources] };
}
