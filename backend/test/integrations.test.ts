import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { eq, sql } from 'drizzle-orm';
import { freshDb } from './db.js';
import { seedGoogle, gres } from './helpers.js';
import { db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { decrypt } from '../src/lib/crypto.js';
import { addDays } from '../src/lib/dates.js';
import { buildAuthUrl, handleCallback, getAuthedClient } from '../src/services/google/oauth.js';
import { discoverSearchConsoleProperties, syncSearchConsoleProperty, ensureWebsitesForSelected } from '../src/services/google/searchConsole.js';
import { syncGa4Property } from '../src/services/google/ga4.js';
import { syncAdmobAccount } from '../src/services/google/admob.js';
import { syncPlayApp } from '../src/services/google/playReporting.js';
import { seoTotals, dimensionTable, admobTotals, admobGrouped, vitalsSummary, ga4Totals } from '../src/services/metrics.js';
import { enqueue, claimNext, fail, recoverStaleJobs } from '../src/services/sync/queue.js';
import { handleJob } from '../src/services/sync/handlers.js';
import { evaluateAlerts } from '../src/services/alerts.js';
import { buildReport } from '../src/services/reports/builder.js';
import { renderPdf, renderExcel, renderCsv } from '../src/services/reports/render.js';
import { generateDailyReport } from '../src/services/reports/daily.js';

/* ----------------------------- mock factories ----------------------------- */

function days(end: string, n: number) {
  return Array.from({ length: n }, (_, i) => addDays(end, -(n - 1 - i)));
}

function mockSearchConsole(opts: { end: string; n: number; clicks: (i: number) => number; fail?: boolean }) {
  const ds = days(opts.end, opts.n);
  return {
    sites: { list: vi.fn(() => gres({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }, { siteUrl: 'https://blog.example.org/', permissionLevel: 'siteFullUser' }] })) },
    searchanalytics: {
      query: vi.fn(({ requestBody }: { requestBody: { dimensions: string[]; startRow?: number } }) => {
        if (opts.fail) return Promise.reject(Object.assign(new Error('Forbidden'), { response: { status: 403, data: { error: { message: 'User does not have sufficient permission' } } } }));
        if ((requestBody.startRow ?? 0) > 0) return gres({ rows: [] });
        const dims = requestBody.dimensions;
        const rows = ds.flatMap((d, i) => {
          const c = opts.clicks(i);
          if (dims.length === 1) return [{ keys: [d], clicks: c, impressions: c * 20, ctr: 0.05, position: 8 }];
          if (dims[1] === 'query')
            return [
              { keys: [d, 'best widgets'], clicks: c * 0.6, impressions: c * 10, ctr: 0.06, position: i < opts.n * 0.75 ? 4 : 12 },
              { keys: [d, 'cheap widgets'], clicks: c * 0.02, impressions: 500, ctr: 0.002, position: 9 },
            ];
          if (dims[1] === 'page') return [{ keys: [d, 'https://example.com/widgets'], clicks: c, impressions: c * 20, ctr: 0.05, position: 8 }];
          if (dims[1] === 'country') return [{ keys: [d, 'pak'], clicks: c, impressions: c * 20, ctr: 0.05, position: 8 }];
          return [{ keys: [d, 'MOBILE'], clicks: c, impressions: c * 20, ctr: 0.05, position: 8 }];
        });
        return gres({ rows, metadata: dims.length === 1 ? { firstIncompleteDate: ds[ds.length - 1] } : undefined });
      }),
    },
    sitemaps: { list: vi.fn(() => gres({ sitemap: [{ path: 'https://example.com/sitemap.xml', errors: '2', warnings: '1', lastDownloaded: '2026-11-10T00:00:00Z', contents: [{ type: 'web', submitted: '120' }] }] })) },
    urlInspection: { index: { inspect: vi.fn() } },
  };
}

beforeEach(async () => {
  await freshDb();
});
afterEach(() => vi.restoreAllMocks());

/* --------------------------------- OAuth --------------------------------- */

describe('Google OAuth flow', () => {
  it('validates state, exchanges the code and stores only encrypted tokens', async () => {
    const { user } = await seedGoogle();
    const url = new URL(await buildAuthUrl(user.id));
    const state = url.searchParams.get('state')!;
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: { access_token: 'ya29.access', refresh_token: '1//refresh-NEW', id_token: 'idt', scope: 'openid https://www.googleapis.com/auth/webmasters.readonly', expiry_date: Date.now() + 3600_000 },
      res: null,
    } as never);
    vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({ getPayload: () => ({ sub: 'sub-1', email: 'owner@example.com' }) } as never);
    const r = await handleCallback('auth-code', state);
    expect(r.email).toBe('owner@example.com');
    const [cred] = await db.select().from(s.oauthCredentials);
    expect(cred.encryptedRefreshToken).not.toContain('refresh-NEW');
    expect(decrypt(cred.encryptedRefreshToken)).toBe('1//refresh-NEW');
    // state is single-use
    await expect(handleCallback('auth-code', state)).rejects.toThrow(/state/i);
    const svc = await db.select().from(s.connectedServices);
    expect(svc.find((x) => x.service === 'search_console')?.status).toBe('connected');
    expect(svc.find((x) => x.service === 'admob')?.status).toBe('needs_setup');
  });

  it('persists refreshed access tokens (encrypted)', async () => {
    await seedGoogle();
    const client = await getAuthedClient();
    client.emit('tokens', { access_token: 'ya29.rotated', expiry_date: Date.now() + 7200_000 });
    await new Promise((r) => setTimeout(r, 50));
    const [cred] = await db.select().from(s.oauthCredentials);
    expect(decrypt(cred.encryptedAccessToken!)).toBe('ya29.rotated');
  });
});

/* ----------------------------- Search Console ----------------------------- */

describe('Search Console integration', () => {
  it('discovers properties, syncs, upserts idempotently and labels fresh data', async () => {
    await seedGoogle();
    const end = '2026-11-15';
    const mock = mockSearchConsole({ end, n: 28, clicks: (i) => (i < 21 ? 100 : 50) });
    await discoverSearchConsoleProperties(mock as never);
    const props = await db.select().from(s.searchConsoleProperties);
    expect(props.map((p) => p.propertyType).sort()).toEqual(['domain', 'url_prefix']);
    const dom = props.find((p) => p.siteUrl === 'sc-domain:example.com')!;
    await db.update(s.searchConsoleProperties).set({ isSelected: true }).where(eq(s.searchConsoleProperties.id, dom.id));
    expect(await ensureWebsitesForSelected()).toBe(1);

    const range = { start: addDays(end, -27), end };
    await syncSearchConsoleProperty(dom.id, range, { client: mock as never });
    await syncSearchConsoleProperty(dom.id, range, { client: mock as never }); // second run must not duplicate
    const [{ c }] = (await db.execute(sql`select count(*)::int c from website_daily_metrics`)).rows as Array<{ c: number }>;
    expect(c).toBe(28);
    const fresh = await db.select().from(s.websiteDailyMetrics).where(eq(s.websiteDailyMetrics.dataState, 'fresh'));
    expect(fresh.map((f) => f.metricDate)).toEqual([end]);

    const cur = { start: addDays(end, -13), end };
    const prev = { start: addDays(end, -27), end: addDays(end, -14) };
    const t = await seoTotals([dom.id], cur);
    expect(t.clicks).toBe(1050);
    expect(t.position).toBeCloseTo(8);

    const kw = await dimensionTable('query', [dom.id], cur, prev, {});
    const best = kw.rows.find((r) => r.key === 'best widgets')!;
    expect(best.prevPosition).toBeCloseTo(4);
    expect(best.position).toBeCloseTo(70000 / 10500, 2); // impression-weighted
    expect(best.positionChange).toBeCloseTo(4 - 70000 / 10500, 2);
    expect(best.flags).toContain('declining');
    expect(best.flags).toContain('losing_clicks');
    const cheap = kw.rows.find((r) => r.key === 'cheap widgets')!;
    expect(cheap.flags).toContain('low_ctr');
    const declining = await dimensionTable('query', [dom.id], cur, prev, { filter: 'declining' });
    expect(declining.rows.map((r) => r.key)).toEqual(['best widgets']);

    const maps = await db.select().from(s.sitemapRecords);
    expect(maps[0].errors).toBe(2);

    // alerts fire once, deduplicated on re-evaluation
    const created = await evaluateAlerts('search_console');
    expect(created).toBeGreaterThanOrEqual(3); // clicks decline, keyword drop, sitemap error
    expect(await evaluateAlerts('search_console')).toBe(0);
    const notes = await db.select().from(s.notifications);
    expect(notes.some((n) => n.type === 'traffic_decline')).toBe(true);
    expect(notes.some((n) => n.type === 'keyword_position_change')).toBe(true);
  });

  it('isolates failures: one failing property does not stop the others', async () => {
    await seedGoogle();
    const good = mockSearchConsole({ end: '2026-11-15', n: 3, clicks: () => 10 });
    const bad = mockSearchConsole({ end: '2026-11-15', n: 3, clicks: () => 10, fail: true });
    await discoverSearchConsoleProperties(good as never);
    await db.update(s.searchConsoleProperties).set({ isSelected: true });
    let call = 0;
    vi.spyOn(google, 'searchconsole').mockImplementation((() => {
      // first property gets the failing client
      return call++ === 0 ? bad : good;
    }) as never);
    const { job } = await enqueue('search_console', { trigger: 'manual', params: { start: '2026-11-13', end: '2026-11-15' } });
    const r = await handleJob(job);
    expect(r.status).toBe('partial');
    expect(r.result.synced).toBe(1);
    expect(r.result.failed).toBe(1);
    const failed = await db.select().from(s.searchConsoleProperties).where(eq(s.searchConsoleProperties.syncStatus, 'failed'));
    expect(failed).toHaveLength(1);
    expect(failed[0].lastError).toMatch(/permission/);
  });
});

/* ---------------------------------- GA4 ---------------------------------- */

describe('GA4 integration', () => {
  it('stores daily metrics and breakdowns, falling back from keyEvents to conversions', async () => {
    await seedGoogle();
    const [p] = await db.insert(s.ga4Properties).values({ propertyName: 'properties/123', displayName: 'Example', isSelected: true, timeZone: 'UTC', currencyCode: 'USD' }).returning();
    let keyEventCalls = 0;
    const api = {
      properties: {
        runReport: vi.fn(({ requestBody }: { requestBody: { dimensions: Array<{ name: string }>; metrics: Array<{ name: string }> } }) => {
          const metrics = requestBody.metrics.map((m) => m.name);
          if (metrics.includes('keyEvents')) {
            keyEventCalls++;
            return Promise.reject(new Error('Field keyEvents is not a valid metric'));
          }
          const dims = requestBody.dimensions.map((d) => d.name);
          const rows = ['20261114', '20261115'].map((d) => ({
            dimensionValues: [{ value: d }, ...(dims[1] ? [{ value: dims[1] === 'country' ? 'Pakistan' : 'mobile' }] : [])],
            metricValues: metrics.map((m) => ({ value: m === 'engagementRate' ? '0.5' : m === 'totalRevenue' ? '12.5' : '10' })),
          }));
          return gres({ dimensionHeaders: dims.map((name) => ({ name })), metricHeaders: metrics.map((name) => ({ name })), rows, rowCount: rows.length });
        }),
      },
    };
    const r = await syncGa4Property(p.id, { start: '2026-11-14', end: '2026-11-15' }, { client: api as never });
    expect(r.days).toBe(2);
    expect(keyEventCalls).toBeGreaterThan(0);
    const rows = await db.select().from(s.analyticsDailyMetrics);
    expect(rows).toHaveLength(2);
    expect(rows[0].keyEvents).toBe(10);
    expect(rows[0].totalRevenue).toBe(12.5);
    const t = await ga4Totals([p.id], { start: '2026-11-14', end: '2026-11-15' });
    expect(t.sessions).toBe(20);
    expect(t.engagementRate).toBe(1); // engaged 20 / sessions 20
    expect(t.revenueCurrency).toBe('USD');
  });
});

/* ---------------------------------- AdMob ---------------------------------- */

describe('AdMob integration', () => {
  it('stores micros in the original currency and derives eCPM / match rate', async () => {
    await seedGoogle();
    const [acct] = await db.insert(s.admobAccounts).values({ resourceName: 'accounts/pub-1', publisherId: 'pub-1', currencyCode: 'USD' }).returning();
    const row = (date: string, app: string, country: string, fmt: string, micros: number, imp: number) => ({
      row: {
        dimensionValues: { DATE: { value: date }, APP: { value: app, displayLabel: `App ${app}` }, COUNTRY: { value: country }, FORMAT: { value: fmt } },
        metricValues: { ESTIMATED_EARNINGS: { microsValue: String(micros) }, IMPRESSIONS: { integerValue: String(imp) }, CLICKS: { integerValue: '5' }, AD_REQUESTS: { integerValue: String(imp * 2) }, MATCHED_REQUESTS: { integerValue: String(imp + 100) } },
      },
    });
    const api = {
      accounts: {
        networkReport: {
          generate: vi.fn(() =>
            gres([
              { header: { localizationSettings: { currencyCode: 'USD' } } },
              row('20261115', 'ca-app-pub-1~1', 'PK', 'BANNER', 2_000_000, 1000),
              row('20261115', 'ca-app-pub-1~1', 'US', 'INTERSTITIAL', 8_000_000, 1000),
              row('20261115', 'ca-app-pub-1~2', 'US', 'REWARDED', 0, 500),
              { footer: { matchingRowCount: '3' } },
            ]),
          ),
        },
      },
    };
    await syncAdmobAccount(acct.id, { start: '2026-11-15', end: '2026-11-15' }, api as never);
    await syncAdmobAccount(acct.id, { start: '2026-11-15', end: '2026-11-15' }, api as never);
    const [tot] = await admobTotals({ start: '2026-11-15', end: '2026-11-15' });
    expect(tot.currency).toBe('USD');
    expect(tot.earnings).toBe(10);
    expect(tot.impressions).toBe(2500);
    expect(tot.ecpm).toBeCloseTo(4); // 10 / 2500 * 1000
    expect(tot.matchRate).toBeCloseTo((2800 / 5000) * 100);
    const byApp = await admobGrouped('app', { start: '2026-11-15', end: '2026-11-15' });
    expect(byApp[0]).toMatchObject({ key: 'ca-app-pub-1~1', earnings: 10 });
    // genuine zero earnings stay 0, not null
    expect(byApp.find((a) => a.key === 'ca-app-pub-1~2')?.earnings).toBe(0);
    const formats = await admobGrouped('format', { start: '2026-11-15', end: '2026-11-15' });
    expect(formats.map((f) => f.key)).toEqual(['INTERSTITIAL', 'BANNER', 'REWARDED']);
  });
});

/* ------------------------------- Play vitals ------------------------------- */

describe('Play Developer Reporting integration', () => {
  it('stores rates as percentages, isolates unavailable metric sets', async () => {
    const [app] = await db.insert(s.playConsoleApps).values({ resourceName: 'apps/com.example.app', packageName: 'com.example.app', isSelected: true }).returning();
    const dayRow = (d: number, metrics: Record<string, string>) => ({
      startTime: { year: 2026, month: 11, day: d },
      metrics: Object.entries(metrics).map(([metric, value]) => ({ metric, decimalValue: { value } })),
    });
    const ok = (metrics: Record<string, string>) => vi.fn(() => gres({ rows: [dayRow(14, metrics), dayRow(15, metrics)] }));
    const api = {
      vitals: {
        crashrate: { query: ok({ crashRate: '0.015', userPerceivedCrashRate: '0.01', distinctUsers: '1000' }) },
        anrrate: { query: ok({ anrRate: '0.002', distinctUsers: '1000' }) },
        slowstartrate: { query: vi.fn(() => Promise.reject(Object.assign(new Error('Not enough data'), { response: { status: 400 } }))) },
        slowrenderingrate: { query: ok({ slowRenderingRate20Fps: '0.05', distinctUsers: '900' }) },
        excessivewakeuprate: { query: ok({ excessiveWakeupRate: '0.001', distinctUsers: '900' }) },
        stuckbackgroundwakelockrate: { query: ok({ stuckBgWakelockRate: '0.0', distinctUsers: '900' }) },
        errors: { counts: { query: ok({ errorReportCount: '42', distinctUsers: '30' }) } },
      },
    };
    const r = await syncPlayApp(app.id, { start: '2026-11-14', end: '2026-11-15' }, api as never);
    expect(r.results.slowStartRate).toBe('unavailable');
    const [row] = await db.select().from(s.playConsoleApps);
    expect(row.syncStatus).toBe('partial');
    const v = await vitalsSummary([app.id], { start: '2026-11-14', end: '2026-11-15' });
    expect(v.find((x) => x.metric === 'crashRate')?.value).toBeCloseTo(1.5);
    expect(v.find((x) => x.metric === 'errorReportCount')?.value).toBe(84);
    expect(await evaluateAlerts('play_reporting')).toBe(1); // crash 1.5% ≥ 1.09% warning
  });
});

/* ------------------------------- Sync queue ------------------------------- */

describe('Postgres job queue', () => {
  it('prevents duplicate active jobs, claims atomically, retries with backoff', async () => {
    const a = await enqueue('ga4', { targetId: 'x' });
    const b = await enqueue('ga4', { targetId: 'x' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    const c = await enqueue('ga4', { targetId: 'y' });
    expect(c.created).toBe(true);

    const claimed = await claimNext();
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    expect(await fail(claimed!, 'HTTP 503', true)).toBe('retrying');
    const [j] = await db.select().from(s.syncJobs).where(eq(s.syncJobs.id, claimed!.id));
    expect(j.status).toBe('pending');
    expect(j.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect(await fail({ ...j, attempts: 3 }, 'still failing', true)).toBe('failed');

    // stale running job is recovered
    const d = await claimNext();
    await db.update(s.syncJobs).set({ heartbeatAt: new Date(Date.now() - 3600_000), startedAt: new Date(Date.now() - 3600_000) }).where(eq(s.syncJobs.id, d!.id));
    expect(await recoverStaleJobs()).toBe(1);
  });
});

/* -------------------------------- Reports -------------------------------- */

describe('Report generation', () => {
  it('renders PDF, Excel and CSV including empty states', async () => {
    const cur = { start: '2026-11-01', end: '2026-11-15' };
    const prev = { start: '2026-10-17', end: '2026-10-31' };
    for (const type of ['portfolio', 'admob', 'play_health', 'keywords', 'ai_recommendations', 'monthly_executive'] as const) {
      const doc = await buildReport(type, cur, prev);
      expect(doc.sections.length, type).toBeGreaterThan(0);
      const pdf = await renderPdf(doc);
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      const xlsx = await renderExcel(doc);
      expect(xlsx.subarray(0, 2).toString()).toBe('PK');
      expect(renderCsv(doc).toString()).toContain(doc.title);
    }
  });

  it('builds a daily report from stored data', async () => {
    await seedGoogle();
    const mock = mockSearchConsole({ end: '2026-11-15', n: 3, clicks: () => 10 });
    await discoverSearchConsoleProperties(mock as never);
    await db.update(s.searchConsoleProperties).set({ isSelected: true });
    await ensureWebsitesForSelected();
    const props = await db.select().from(s.searchConsoleProperties);
    for (const p of props) await syncSearchConsoleProperty(p.id, { start: '2026-11-13', end: '2026-11-15' }, { client: mock as never });
    const r = await generateDailyReport('2026-11-15', { email: false });
    expect(r.websites).toBe(2);
    const [row] = await db.select().from(s.dailyReports);
    const content = row.content as { websites: Array<{ seo: { clicks: number } | null }> };
    expect(content.websites[0].seo?.clicks).toBe(10);
  });
});
