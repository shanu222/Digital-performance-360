import { google, type admob_v1 } from 'googleapis';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { admobAccounts, admobApps, admobDailyMetrics, androidApps } from '../../db/schema.js';
import { getAuthedClient } from './oauth.js';
import { withRetry } from '../../lib/retry.js';
import { chunk, ga4Date } from '../../lib/util.js';
import { toYmdParts } from '../../lib/dates.js';
import { notFound } from '../../lib/http.js';

export async function admobClient(accountId?: string | null): Promise<admob_v1.Admob> {
  return google.admob({ version: 'v1', auth: await getAuthedClient(accountId) });
}

/** Discover AdMob publisher accounts, apps and ad units; link Android apps by Play package name. */
export async function discoverAdmob(client?: admob_v1.Admob, accountId?: string | null) {
  const api = client ?? (await admobClient(accountId));
  const accts = await withRetry(() => api.accounts.list({ pageSize: 20 }), { label: 'admob.accounts.list' });
  let appCount = 0;
  for (const a of accts.data.account ?? []) {
    if (!a.name) continue;
    const [acct] = await db
      .insert(admobAccounts)
      .values({
        resourceName: a.name,
        publisherId: a.publisherId ?? a.name.replace('accounts/', ''),
        currencyCode: a.currencyCode ?? null,
        reportingTimeZone: a.reportingTimeZone ?? null,
        googleAccountId: accountId ?? null,
      })
      .onConflictDoUpdate({
        target: admobAccounts.resourceName,
        set: {
          currencyCode: a.currencyCode ?? null,
          reportingTimeZone: a.reportingTimeZone ?? null,
          googleAccountId: sql.raw(`coalesce((select ga.id from google_accounts ga where ga.id = admob_accounts.google_account_id and ga.status <> 'revoked'), excluded.google_account_id)`),
          updatedAt: new Date(),
        },
      })
      .returning();

    // Ad units grouped by app
    const unitsByApp = new Map<string, Array<{ adUnitId: string; displayName: string; adFormat: string }>>();
    let unitToken: string | undefined;
    do {
      const res = await withRetry(() => api.accounts.adUnits.list({ parent: a.name!, pageSize: 1000, pageToken: unitToken }));
      for (const u of res.data.adUnits ?? []) {
        if (!u.appId) continue;
        const list = unitsByApp.get(u.appId) ?? [];
        list.push({ adUnitId: u.adUnitId ?? '', displayName: u.displayName ?? '', adFormat: u.adFormat ?? '' });
        unitsByApp.set(u.appId, list);
      }
      unitToken = res.data.nextPageToken ?? undefined;
    } while (unitToken);

    let appToken: string | undefined;
    do {
      const res = await withRetry(() => api.accounts.apps.list({ parent: a.name!, pageSize: 1000, pageToken: appToken }));
      for (const app of res.data.apps ?? []) {
        if (!app.appId || !app.name) continue;
        appCount++;
        const displayName = app.linkedAppInfo?.displayName ?? app.manualAppInfo?.displayName ?? app.appId;
        const storeId = app.linkedAppInfo?.appStoreId ?? null;
        const [row] = await db
          .insert(admobApps)
          .values({
            admobAccountId: acct.id,
            appId: app.appId,
            resourceName: app.name,
            displayName,
            platform: app.platform ?? null,
            storeId,
            approvalState: app.appApprovalState ?? null,
            adUnits: unitsByApp.get(app.appId) ?? [],
          })
          .onConflictDoUpdate({
            target: admobApps.appId,
            set: {
              displayName,
              platform: app.platform ?? null,
              storeId,
              approvalState: app.appApprovalState ?? null,
              adUnits: unitsByApp.get(app.appId) ?? [],
              updatedAt: new Date(),
            },
          })
          .returning();
        // Auto-register linked Android apps (package name known from the Play listing)
        if (app.platform === 'ANDROID' && storeId) {
          await db
            .insert(androidApps)
            .values({ name: displayName, packageName: storeId, admobAppId: row.id, source: 'discovered' })
            .onConflictDoUpdate({ target: androidApps.packageName, set: { admobAppId: row.id, updatedAt: new Date() } });
        }
      }
      appToken = res.data.nextPageToken ?? undefined;
    } while (appToken);
  }
  return { accounts: accts.data.account?.length ?? 0, apps: appCount };
}

type ReportChunk = admob_v1.Schema$GenerateNetworkReportResponse;

/** The network report endpoint streams a JSON array: [header, ...rows, footer]. */
export function parseNetworkReport(data: unknown) {
  const parts: ReportChunk[] = Array.isArray(data) ? data : [data as ReportChunk];
  const header = parts.find((p) => p.header)?.header;
  const footer = parts.find((p) => p.footer)?.footer;
  const rows = parts.filter((p) => p.row).map((p) => p.row!);
  return { header, footer, rows, currency: header?.localizationSettings?.currencyCode ?? null };
}

const intOf = (v?: admob_v1.Schema$ReportRowMetricValue) => (v?.integerValue != null ? Number(v.integerValue) : null);
const microsOf = (v?: admob_v1.Schema$ReportRowMetricValue) => (v?.microsValue != null ? Number(v.microsValue) : null);

export async function syncAdmobAccount(accountId: string, range: { start: string; end: string }, client?: admob_v1.Admob) {
  const [acct] = await db.select().from(admobAccounts).where(eq(admobAccounts.id, accountId));
  if (!acct) throw notFound('AdMob account');
  const api = client ?? (await admobClient(acct.googleAccountId));
  const res = await withRetry(
    () =>
      api.accounts.networkReport.generate({
        parent: acct.resourceName,
        requestBody: {
          reportSpec: {
            dateRange: { startDate: toYmdParts(range.start), endDate: toYmdParts(range.end) },
            dimensions: ['DATE', 'APP', 'COUNTRY', 'FORMAT'],
            metrics: ['ESTIMATED_EARNINGS', 'IMPRESSIONS', 'CLICKS', 'AD_REQUESTS', 'MATCHED_REQUESTS'],
            // No currency override: values stay in the account's reporting currency.
          },
        },
      }),
    { label: 'admob.networkReport' },
  );
  const report = parseNetworkReport(res.data);
  const currency = report.currency ?? acct.currencyCode ?? 'USD';
  const now = new Date();
  const rows = report.rows.map((r) => {
    const d = r.dimensionValues ?? {};
    const m = r.metricValues ?? {};
    return {
      admobAccountId: acct.id,
      metricDate: ga4Date(d.DATE?.value ?? ''),
      appId: d.APP?.value ?? '(unknown)',
      appLabel: d.APP?.displayLabel ?? null,
      country: d.COUNTRY?.value || 'ZZ',
      format: d.FORMAT?.value || 'UNKNOWN',
      estimatedEarningsMicros: microsOf(m.ESTIMATED_EARNINGS),
      impressions: intOf(m.IMPRESSIONS),
      clicks: intOf(m.CLICKS),
      adRequests: intOf(m.AD_REQUESTS),
      matchedRequests: intOf(m.MATCHED_REQUESTS),
      currency,
      retrievedAt: now,
    };
  });
  for (const part of chunk(rows, 1000)) {
    await db
      .insert(admobDailyMetrics)
      .values(part)
      .onConflictDoUpdate({
        target: [admobDailyMetrics.admobAccountId, admobDailyMetrics.metricDate, admobDailyMetrics.appId, admobDailyMetrics.country, admobDailyMetrics.format],
        set: {
          appLabel: sql`excluded.app_label`,
          estimatedEarningsMicros: sql`excluded.estimated_earnings_micros`,
          impressions: sql`excluded.impressions`,
          clicks: sql`excluded.clicks`,
          adRequests: sql`excluded.ad_requests`,
          matchedRequests: sql`excluded.matched_requests`,
          currency: sql`excluded.currency`,
          retrievedAt: sql`excluded.retrieved_at`,
        },
      });
  }
  const lastDataDate = rows.reduce<string | null>((mx, r) => (!mx || r.metricDate > mx ? r.metricDate : mx), acct.lastDataDate);
  await db
    .update(admobAccounts)
    .set({ currencyCode: currency, lastSyncedAt: now, lastDataDate, syncStatus: 'success', lastError: null, updatedAt: now })
    .where(eq(admobAccounts.id, acct.id));
  return { rows: rows.length, currency, warnings: report.footer?.warnings ?? [] };
}
