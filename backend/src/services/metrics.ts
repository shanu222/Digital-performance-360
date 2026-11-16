/**
 * Query layer over stored historical data. Every function reads PostgreSQL only;
 * nothing here fabricates values — missing data returns null, not 0.
 */
import { sql, type SQL } from 'drizzle-orm';
import { rawRows } from '../db/client.js';
import type { Range } from '../lib/dates.js';
import { pctChange } from '../lib/dates.js';
import type { Settings } from './settings.js';

const f = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/* ============================ Search Console ============================ */

export interface SeoTotals {
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
  days: number;
  freshDays: number;
}

const scPropFilter = (propIds: string[] | null): SQL =>
  propIds === null
    ? sql`search_console_property_id in (select id from search_console_properties where is_selected)`
    : propIds.length
      ? sql`search_console_property_id in (${sql.join(propIds.map((id) => sql`${id}::uuid`), sql`, `)})`
      : sql`false`;

/** Position is impression-weighted, matching how Search Console averages position. */
export async function seoTotals(propIds: string[] | null, r: Range): Promise<SeoTotals> {
  const [row] = await rawRows<Record<string, unknown>>(sql`
    select sum(clicks)::float8 clicks, sum(impressions)::float8 impressions,
      case when sum(impressions) > 0 then sum(clicks)::float8 / sum(impressions) end ctr,
      case when sum(impressions) > 0 then sum(position * impressions)::float8 / sum(impressions) end position,
      count(distinct metric_date)::int days,
      count(distinct metric_date) filter (where data_state = 'fresh')::int fresh_days
    from website_daily_metrics
    where ${scPropFilter(propIds)} and metric_date between ${r.start} and ${r.end}`);
  return {
    clicks: f(row?.clicks),
    impressions: f(row?.impressions),
    ctr: f(row?.ctr),
    position: f(row?.position),
    days: Number(row?.days ?? 0),
    freshDays: Number(row?.fresh_days ?? 0),
  };
}

export async function seoTimeseries(propIds: string[] | null, r: Range) {
  const rows = await rawRows<Record<string, unknown>>(sql`
    select metric_date::text date, sum(clicks)::float8 clicks, sum(impressions)::float8 impressions,
      case when sum(impressions) > 0 then sum(clicks)::float8 / sum(impressions) end ctr,
      case when sum(impressions) > 0 then sum(position * impressions)::float8 / sum(impressions) end position,
      bool_or(data_state = 'fresh') fresh
    from website_daily_metrics
    where ${scPropFilter(propIds)} and metric_date between ${r.start} and ${r.end}
    group by metric_date order by metric_date`);
  return rows.map((x) => ({ date: String(x.date), clicks: f(x.clicks), impressions: f(x.impressions), ctr: f(x.ctr), position: f(x.position), fresh: Boolean(x.fresh) }));
}

export interface TableQuery {
  search?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  filter?: 'all' | 'gaining_impressions' | 'losing_clicks' | 'improving' | 'declining' | 'low_ctr' | 'opportunity';
}

const SORTABLE = new Set(['clicks', 'impressions', 'ctr', 'position', 'position_change', 'click_change', 'impression_change']);

/**
 * Keyword / page comparison table. Position values are averages over each
 * period (Search Console does not provide exact daily rankings).
 */
export async function dimensionTable(kind: 'query' | 'page', propIds: string[] | null, cur: Range, prev: Range, q: TableQuery = {}) {
  const table = kind === 'query' ? sql.raw('keyword_daily_metrics') : sql.raw('page_daily_metrics');
  const col = kind === 'query' ? sql.raw('query') : sql.raw('page');
  const sort = SORTABLE.has(q.sort ?? '') ? q.sort! : 'clicks';
  const dir = q.dir === 'asc' ? sql.raw('asc') : sql.raw('desc');
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
  const offset = Math.max(q.offset ?? 0, 0);
  const search = q.search ? `%${q.search.replace(/[%_]/g, (m) => `\\${m}`)}%` : null;

  const filterSql: Record<string, SQL> = {
    all: sql`true`,
    gaining_impressions: sql`c.impressions > coalesce(p.impressions, 0) * 1.2 and c.impressions >= 50`,
    losing_clicks: sql`p.clicks >= 5 and c.clicks < p.clicks * 0.8`,
    improving: sql`p.position is not null and p.position - c.position >= 1`,
    declining: sql`p.position is not null and c.position - p.position >= 1`,
    low_ctr: sql`c.impressions >= 200 and c.ctr < 0.01 and c.position <= 20`,
    opportunity: sql`c.impressions >= 100 and c.position between 4 and 20`,
  };

  const rows = await rawRows<Record<string, unknown>>(sql`
    with c as (
      select ${col} k, sum(clicks)::float8 clicks, sum(impressions)::float8 impressions,
        case when sum(impressions) > 0 then sum(clicks)::float8 / sum(impressions) end ctr,
        case when sum(impressions) > 0 then sum(position * impressions)::float8 / sum(impressions) end position
      from ${table} where ${scPropFilter(propIds)} and metric_date between ${cur.start} and ${cur.end}
      ${search ? sql`and ${col} ilike ${search}` : sql``}
      group by ${col}
    ), p as (
      select ${col} k, sum(clicks)::float8 clicks, sum(impressions)::float8 impressions,
        case when sum(impressions) > 0 then sum(position * impressions)::float8 / sum(impressions) end position
      from ${table} where ${scPropFilter(propIds)} and metric_date between ${prev.start} and ${prev.end}
      ${search ? sql`and ${col} ilike ${search}` : sql``}
      group by ${col}
    )
    select c.k, c.clicks, c.impressions, c.ctr, c.position,
      p.clicks prev_clicks, p.impressions prev_impressions, p.position prev_position,
      (p.position - c.position) position_change,
      (c.clicks - coalesce(p.clicks, 0)) click_change,
      (c.impressions - coalesce(p.impressions, 0)) impression_change,
      count(*) over() total
    from c left join p on p.k = c.k
    where ${filterSql[q.filter ?? 'all'] ?? sql`true`}
    order by ${sql.raw(sort)} ${dir} nulls last
    limit ${limit} offset ${offset}`);

  const total = rows.length ? Number(rows[0].total) : 0;
  return {
    total,
    rows: rows.map((r) => {
      const ctr = f(r.ctr);
      const pos = f(r.position);
      const imp = f(r.impressions) ?? 0;
      const flags: string[] = [];
      if (r.prev_impressions != null && imp > Number(r.prev_impressions) * 1.2 && imp >= 50) flags.push('gaining_impressions');
      if (r.prev_clicks != null && Number(r.prev_clicks) >= 5 && Number(r.clicks) < Number(r.prev_clicks) * 0.8) flags.push('losing_clicks');
      if (r.position_change != null && Number(r.position_change) >= 1) flags.push('improving');
      if (r.position_change != null && Number(r.position_change) <= -1) flags.push('declining');
      if (imp >= 200 && ctr != null && ctr < 0.01 && pos != null && pos <= 20) flags.push('low_ctr');
      if (imp >= 100 && pos != null && pos >= 4 && pos <= 20) flags.push('opportunity');
      return {
        key: String(r.k),
        clicks: f(r.clicks),
        impressions: f(r.impressions),
        ctr,
        position: pos,
        prevClicks: f(r.prev_clicks),
        prevImpressions: f(r.prev_impressions),
        prevPosition: f(r.prev_position),
        /** positive = moved up (better) */
        positionChange: f(r.position_change),
        clickChangePct: pctChange(f(r.clicks), f(r.prev_clicks)),
        flags,
      };
    }),
  };
}

/** Daily series for a single keyword or page (sparkline / trend). */
export async function dimensionTrend(kind: 'query' | 'page', propIds: string[] | null, key: string, r: Range) {
  const table = kind === 'query' ? sql.raw('keyword_daily_metrics') : sql.raw('page_daily_metrics');
  const col = kind === 'query' ? sql.raw('query') : sql.raw('page');
  const rows = await rawRows<Record<string, unknown>>(sql`
    select metric_date::text date, sum(clicks)::float8 clicks, sum(impressions)::float8 impressions,
      case when sum(impressions) > 0 then sum(position * impressions)::float8 / sum(impressions) end position
    from ${table} where ${scPropFilter(propIds)} and ${col} = ${key} and metric_date between ${r.start} and ${r.end}
    group by metric_date order by metric_date`);
  return rows.map((x) => ({ date: String(x.date), clicks: f(x.clicks), impressions: f(x.impressions), position: f(x.position) }));
}

/* ============================ Breakdowns ============================ */

export async function breakdown(source: 'search_console' | 'ga4', propIds: string[] | null, dimension: string, r: Range, limit = 50) {
  const propSql =
    propIds === null
      ? source === 'ga4'
        ? sql`property_id in (select id from ga4_properties where is_selected)`
        : sql`property_id in (select id from search_console_properties where is_selected)`
      : propIds.length
        ? sql`property_id in (${sql.join(propIds.map((id) => sql`${id}::uuid`), sql`, `)})`
        : sql`false`;
  const rows = await rawRows<Record<string, unknown>>(sql`
    select dimension_value value,
      sum(clicks)::float8 clicks, sum(impressions)::float8 impressions,
      case when sum(impressions) > 0 then sum(clicks)::float8 / sum(impressions) end ctr,
      case when sum(impressions) > 0 then sum(position * impressions)::float8 / sum(impressions) end position,
      sum(active_users)::float8 active_users, sum(new_users)::float8 new_users, sum(sessions)::float8 sessions,
      sum(engaged_sessions)::float8 engaged_sessions, sum(screen_page_views)::float8 screen_page_views, sum(key_events)::float8 key_events
    from country_daily_metrics
    where source = ${source} and ${propSql} and dimension = ${dimension} and metric_date between ${r.start} and ${r.end}
    group by dimension_value
    order by ${source === 'ga4' ? sql.raw(dimension === 'page' ? 'screen_page_views' : 'sessions') : sql.raw('clicks')} desc nulls last
    limit ${limit}`);
  return rows.map((x) => ({
    value: String(x.value),
    clicks: f(x.clicks),
    impressions: f(x.impressions),
    ctr: f(x.ctr),
    position: f(x.position),
    activeUsers: f(x.active_users),
    newUsers: f(x.new_users),
    sessions: f(x.sessions),
    engagedSessions: f(x.engaged_sessions),
    engagementRate: x.sessions ? (f(x.engaged_sessions) ?? 0) / Number(x.sessions) : null,
    screenPageViews: f(x.screen_page_views),
    keyEvents: f(x.key_events),
  }));
}

/* ============================ GA4 ============================ */

const gaFilter = (propIds: string[] | null): SQL =>
  propIds === null
    ? sql`ga4_property_id in (select id from ga4_properties where is_selected)`
    : propIds.length
      ? sql`ga4_property_id in (${sql.join(propIds.map((id) => sql`${id}::uuid`), sql`, `)})`
      : sql`false`;

export async function ga4Totals(propIds: string[] | null, r: Range) {
  const [row] = await rawRows<Record<string, unknown>>(sql`
    select sum(active_users)::float8 active_users_daily_sum, sum(new_users)::float8 new_users, sum(sessions)::float8 sessions,
      sum(engaged_sessions)::float8 engaged_sessions, sum(screen_page_views)::float8 screen_page_views, sum(event_count)::float8 event_count,
      sum(key_events)::float8 key_events, sum(total_revenue)::float8 total_revenue, sum(user_engagement_duration)::float8 engagement_seconds,
      count(distinct metric_date)::int days, max(retrieved_at) retrieved_at,
      array_remove(array_agg(distinct currency), null) currencies
    from analytics_daily_metrics where ${gaFilter(propIds)} and metric_date between ${r.start} and ${r.end}`);
  const sessions = f(row?.sessions);
  const engaged = f(row?.engaged_sessions);
  const usersSum = f(row?.active_users_daily_sum);
  const currencies = (row?.currencies as string[] | null) ?? [];
  return {
    /** Sum of daily active users — users are not additive; see liveRangeUsers for deduplicated totals */
    activeUsersDailySum: usersSum,
    newUsers: f(row?.new_users),
    sessions,
    engagedSessions: engaged,
    engagementRate: sessions ? (engaged ?? 0) / sessions : null,
    avgEngagementTimeSec: usersSum ? (f(row?.engagement_seconds) ?? 0) / usersSum : null,
    screenPageViews: f(row?.screen_page_views),
    eventCount: f(row?.event_count),
    keyEvents: f(row?.key_events),
    // revenue only when a single currency is involved (never mix currencies)
    totalRevenue: currencies.length <= 1 ? f(row?.total_revenue) : null,
    revenueCurrency: currencies.length === 1 ? currencies[0] : currencies.length > 1 ? 'MIXED' : null,
    days: Number(row?.days ?? 0),
    retrievedAt: row?.retrieved_at ?? null,
  };
}

export async function ga4Timeseries(propIds: string[] | null, r: Range) {
  const rows = await rawRows<Record<string, unknown>>(sql`
    select metric_date::text date, sum(active_users)::float8 active_users, sum(new_users)::float8 new_users,
      sum(sessions)::float8 sessions, sum(engaged_sessions)::float8 engaged_sessions, sum(screen_page_views)::float8 views, sum(key_events)::float8 key_events
    from analytics_daily_metrics where ${gaFilter(propIds)} and metric_date between ${r.start} and ${r.end}
    group by metric_date order by metric_date`);
  return rows.map((x) => ({
    date: String(x.date),
    activeUsers: f(x.active_users),
    newUsers: f(x.new_users),
    sessions: f(x.sessions),
    engagedSessions: f(x.engaged_sessions),
    views: f(x.views),
    keyEvents: f(x.key_events),
  }));
}

/* ============================ AdMob ============================ */

const admobAppFilter = (appIds?: string[] | null): SQL =>
  appIds && appIds.length ? sql`and app_id in (${sql.join(appIds.map((a) => sql`${a}`), sql`, `)})` : sql``;

/** Totals grouped by currency — earnings in different currencies are never summed together. */
export async function admobTotals(r: Range, appIds?: string[] | null) {
  const rows = await rawRows<Record<string, unknown>>(sql`
    select currency, sum(estimated_earnings_micros)::float8 / 1e6 earnings, sum(impressions)::float8 impressions,
      sum(clicks)::float8 clicks, sum(ad_requests)::float8 ad_requests, sum(matched_requests)::float8 matched_requests,
      count(distinct metric_date)::int days, max(retrieved_at) retrieved_at
    from admob_daily_metrics
    where admob_account_id in (select id from admob_accounts where is_selected) and metric_date between ${r.start} and ${r.end} ${admobAppFilter(appIds)}
    group by currency`);
  return rows.map(admobDerived);
}

function admobDerived(x: Record<string, unknown>) {
  const earnings = f(x.earnings);
  const imp = f(x.impressions);
  const req = f(x.ad_requests);
  const matched = f(x.matched_requests);
  return {
    currency: String(x.currency ?? ''),
    earnings,
    impressions: imp,
    clicks: f(x.clicks),
    adRequests: req,
    matchedRequests: matched,
    /** eCPM = earnings / impressions × 1000 */
    ecpm: earnings != null && imp ? (earnings / imp) * 1000 : null,
    /** match rate = matched / requests × 100 */
    matchRate: matched != null && req ? (matched / req) * 100 : null,
    /** show rate = impressions / matched × 100 */
    showRate: imp != null && matched ? (imp / matched) * 100 : null,
    ctr: imp && x.clicks != null ? (Number(x.clicks) / imp) * 100 : null,
    days: x.days != null ? Number(x.days) : undefined,
    retrievedAt: x.retrieved_at ?? undefined,
  };
}

export async function admobGrouped(by: 'app' | 'country' | 'format' | 'date' | 'month', r: Range, appIds?: string[] | null) {
  const key =
    by === 'app'
      ? sql.raw('app_id')
      : by === 'country'
        ? sql.raw('country')
        : by === 'format'
          ? sql.raw('format')
          : by === 'date'
            ? sql.raw('metric_date::text')
            : sql.raw(`to_char(metric_date, 'YYYY-MM')`);
  const rows = await rawRows<Record<string, unknown>>(sql`
    select ${key} k, max(app_label) label, currency, sum(estimated_earnings_micros)::float8 / 1e6 earnings, sum(impressions)::float8 impressions,
      sum(clicks)::float8 clicks, sum(ad_requests)::float8 ad_requests, sum(matched_requests)::float8 matched_requests
    from admob_daily_metrics
    where admob_account_id in (select id from admob_accounts where is_selected) and metric_date between ${r.start} and ${r.end} ${admobAppFilter(appIds)}
    group by ${key}, currency
    order by ${by === 'date' || by === 'month' ? sql.raw('1 asc') : sql.raw('earnings desc nulls last')}`);
  return rows.map((x) => ({ key: String(x.k), label: by === 'app' ? (x.label as string | null) ?? String(x.k) : String(x.k), ...admobDerived(x) }));
}

/* ============================ Play vitals ============================ */

export type HealthStatus = 'healthy' | 'needs_attention' | 'critical' | 'no_data';

export function classifyHealth(crash: number | null, anr: number | null, t: Settings['thresholds']): HealthStatus {
  if (crash == null && anr == null) return 'no_data';
  if ((crash ?? 0) >= t.crashRateCritical || (anr ?? 0) >= t.anrRateCritical) return 'critical';
  if ((crash ?? 0) >= t.crashRateWarning || (anr ?? 0) >= t.anrRateWarning) return 'needs_attention';
  return 'healthy';
}

/** User-weighted average of each vital over the range (app-level rows only, slice = ''). */
export async function vitalsSummary(playAppIds: string[] | null, r: Range) {
  const filter =
    playAppIds === null
      ? sql`play_console_app_id in (select id from play_console_apps where is_selected)`
      : playAppIds.length
        ? sql`play_console_app_id in (${sql.join(playAppIds.map((id) => sql`${id}::uuid`), sql`, `)})`
        : sql`false`;
  const rows = await rawRows<Record<string, unknown>>(sql`
    with v as (
      select play_console_app_id app, metric_date, metric_set, metric, slice, value from app_vitals
      where ${filter} and metric_date between ${r.start} and ${r.end}
    ), u as (
      select app, metric_date, metric_set, slice, value users from v where metric = 'distinctUsers'
    )
    select v.app::text app, v.metric_set, v.metric, v.slice,
      case when sum(u.users) > 0 then sum(v.value * u.users) / sum(u.users) else avg(v.value) end::float8 value,
      sum(v.value)::float8 total, max(v.metric_date)::text latest
    from v left join u on u.app = v.app and u.metric_date = v.metric_date and u.metric_set = v.metric_set and u.slice = v.slice
    where v.metric <> 'distinctUsers'
    group by v.app, v.metric_set, v.metric, v.slice`);
  return rows.map((x) => ({
    appId: String(x.app),
    metricSet: String(x.metric_set),
    metric: String(x.metric),
    slice: String(x.slice ?? ''),
    // counts are summed, rates are user-weighted averages
    value: x.metric === 'errorReportCount' ? f(x.total) : f(x.value),
    latest: String(x.latest),
  }));
}

export async function vitalsTimeseries(playAppId: string, r: Range) {
  const rows = await rawRows<Record<string, unknown>>(sql`
    select metric_date::text date, metric, value::float8 value from app_vitals
    where play_console_app_id = ${playAppId}::uuid and slice = '' and metric_date between ${r.start} and ${r.end}
      and metric in ('crashRate','anrRate','userPerceivedCrashRate','userPerceivedAnrRate','slowRenderingRate20Fps','excessiveWakeupRate','errorReportCount','distinctUsers')
    order by metric_date`);
  const byDate = new Map<string, Record<string, number | string | null>>();
  for (const x of rows) {
    const d = String(x.date);
    const o = byDate.get(d) ?? { date: d };
    o[String(x.metric)] = f(x.value);
    byDate.set(d, o);
  }
  return [...byDate.values()];
}
