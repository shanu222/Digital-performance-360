import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db, rawRows } from '../db/client.js';
import {
  notifications,
  websites,
  searchConsoleProperties,
  ga4Properties,
  sitemapRecords,
  urlInspections,
  playConsoleApps,
  connectedServices,
} from '../db/schema.js';
import { addDays, pctChange } from '../lib/dates.js';
import { logger, errorMessage } from '../lib/logger.js';
import { getSettings } from './settings.js';
import { seoTotals, ga4Totals, admobTotals, vitalsSummary, dimensionTable } from './metrics.js';
import { sendEmail, emailConfigured } from './email.js';

export interface NewNotification {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  recommendedAction?: string;
  entityType?: string;
  entityId?: string;
  entityLabel?: string;
  dedupeKey: string;
}

/** Insert unless an alert with the same dedupe key exists. Critical alerts are emailed if enabled. */
export async function raiseNotification(n: NewNotification): Promise<boolean> {
  const inserted = await db.insert(notifications).values(n).onConflictDoNothing({ target: notifications.dedupeKey }).returning();
  if (!inserted.length) return false;
  if (n.severity === 'critical') {
    try {
      const s = await getSettings();
      if (s.email.enabled && s.email.criticalAlerts && s.email.recipients.length && emailConfigured()) {
        await sendEmail({
          to: s.email.recipients,
          subject: `[DP360 Critical] ${n.title}`,
          html: `<h2 style="color:#b91c1c">${escapeHtml(n.title)}</h2>
            <p><b>Related:</b> ${escapeHtml(n.entityLabel ?? '—')}</p>
            <p>${escapeHtml(n.description)}</p>
            ${n.recommendedAction ? `<p><b>Recommended action:</b> ${escapeHtml(n.recommendedAction)}</p>` : ''}
            <p style="color:#64748b;font-size:12px">Digital Performance 360 · ${new Date().toISOString()}</p>`,
        });
        await db.update(notifications).set({ emailedAt: new Date() }).where(eq(notifications.id, inserted[0].id));
      }
    } catch (err) {
      logger.warn({ err: errorMessage(err) }, 'Critical alert email failed');
    }
  }
  return true;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const fmtPct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;

async function latestDate(table: 'website_daily_metrics' | 'analytics_daily_metrics' | 'admob_daily_metrics', col: string, id?: string) {
  const [row] = await rawRows<{ d: string | null }>(sql`
    select max(metric_date)::text d from ${sql.raw(table)} ${id ? sql`where ${sql.raw(col)} = ${id}::uuid` : sql``}`);
  return row?.d ?? null;
}

/** Compare the latest 7 complete days with the 7 before. Week-bucketed dedupe keys prevent repeats. */
export async function evaluateAlerts(scope = 'all'): Promise<number> {
  const s = await getSettings();
  const t = s.thresholds;
  let created = 0;
  const raise = async (n: NewNotification) => {
    if (await raiseNotification(n)) created++;
  };

  // ---------- Websites: Search Console + GA4 ----------
  if (scope === 'all' || scope === 'search_console' || scope === 'ga4') {
    const sites = await db
      .select({
        id: websites.id,
        name: websites.name,
        scId: websites.searchConsolePropertyId,
        gaId: websites.ga4PropertyId,
      })
      .from(websites)
      .where(eq(websites.isMonitored, true));

    for (const w of sites) {
      try {
        if (w.scId && scope !== 'ga4') {
          // use only final data for comparisons
          const [row] = await rawRows<{ d: string | null }>(sql`
            select max(metric_date)::text d from website_daily_metrics where search_console_property_id = ${w.scId}::uuid and data_state = 'final'`);
          const end = row?.d;
          if (end) {
            const cur = { start: addDays(end, -6), end };
            const prev = { start: addDays(end, -13), end: addDays(end, -7) };
            const [c, p] = await Promise.all([seoTotals([w.scId], cur), seoTotals([w.scId], prev)]);
            const clickChg = pctChange(c.clicks, p.clicks);
            if (clickChg != null && (p.clicks ?? 0) >= t.minClicksForAlert && clickChg <= -t.trafficDeclinePct) {
              await raise({
                type: 'traffic_decline',
                severity: clickChg <= -50 ? 'critical' : 'warning',
                title: `Search clicks down ${fmtPct(clickChg)} — ${w.name}`,
                description: `Clicks ${p.clicks} → ${c.clicks} (${prev.start}…${prev.end} vs ${cur.start}…${cur.end}).`,
                recommendedAction: 'Open Keywords and Page Performance for this site and filter by "Losing clicks" to find the source.',
                entityType: 'website',
                entityId: w.id,
                entityLabel: w.name,
                dedupeKey: `traffic_decline:${w.id}:${end}`,
              });
            }
            const impChg = pctChange(c.impressions, p.impressions);
            if (impChg != null && (p.impressions ?? 0) >= t.minClicksForAlert * 10 && impChg <= -t.impressionDeclinePct) {
              await raise({
                type: 'impression_decline',
                severity: impChg <= -50 ? 'critical' : 'warning',
                title: `Search impressions down ${fmtPct(impChg)} — ${w.name}`,
                description: `Impressions ${p.impressions} → ${c.impressions} (${cur.start}…${cur.end} vs previous 7 days).`,
                recommendedAction: 'Check Indexing Monitor and sitemap status; inspect top pages that lost impressions.',
                entityType: 'website',
                entityId: w.id,
                entityLabel: w.name,
                dedupeKey: `impression_decline:${w.id}:${end}`,
              });
            }
            // keyword position drops among meaningful queries
            const kw = await dimensionTable('query', [w.scId], cur, prev, { filter: 'declining', sort: 'impressions', limit: 200 });
            const big = kw.rows.filter((r) => (r.impressions ?? 0) >= 100 && (r.positionChange ?? 0) <= -t.keywordPositionChange);
            if (big.length) {
              await raise({
                type: 'keyword_position_change',
                severity: 'warning',
                title: `${big.length} keyword${big.length > 1 ? 's' : ''} dropped ≥${t.keywordPositionChange} positions — ${w.name}`,
                description: big
                  .slice(0, 5)
                  .map((k) => `"${k.key}": ${k.prevPosition?.toFixed(1)} → ${k.position?.toFixed(1)}`)
                  .join('; '),
                recommendedAction: 'Review the ranking pages for these queries for content freshness, intent match and internal links.',
                entityType: 'website',
                entityId: w.id,
                entityLabel: w.name,
                dedupeKey: `kw_drop:${w.id}:${end}`,
              });
            }
          }
          // sitemap errors
          const maps = await db.select().from(sitemapRecords).where(eq(sitemapRecords.searchConsolePropertyId, w.scId));
          for (const m of maps.filter((m) => (m.errors ?? 0) > 0)) {
            await raise({
              type: 'sitemap_error',
              severity: 'warning',
              title: `Sitemap has ${m.errors} error(s) — ${w.name}`,
              description: `${m.path} reports ${m.errors} error(s) and ${m.warnings ?? 0} warning(s).`,
              recommendedAction: 'Open the sitemap report in Search Console and fix invalid URLs or formatting, then resubmit.',
              entityType: 'website',
              entityId: w.id,
              entityLabel: w.name,
              dedupeKey: `sitemap:${m.path}:${m.errors}:${m.lastDownloaded?.toISOString().slice(0, 10) ?? ''}`,
            });
          }
          // recent failed URL inspections
          const fails = await db
            .select()
            .from(urlInspections)
            .where(and(eq(urlInspections.searchConsolePropertyId, w.scId), gte(urlInspections.inspectedAt, new Date(Date.now() - 7 * 86400_000))))
            .orderBy(desc(urlInspections.inspectedAt));
          const seen = new Set<string>();
          for (const f of fails) {
            if (seen.has(f.url)) continue;
            seen.add(f.url);
            if (f.verdict === 'FAIL' || f.verdict === 'PARTIAL') {
              await raise({
                type: 'indexing_issue',
                severity: f.verdict === 'FAIL' ? 'warning' : 'info',
                title: `URL inspection ${f.verdict}: ${f.url}`,
                description: `Coverage: ${f.coverageState ?? 'n/a'}; robots.txt: ${f.robotsTxtState ?? 'n/a'}; indexing: ${f.indexingState ?? 'n/a'}.`,
                recommendedAction: 'Resolve the reported coverage state, then request indexing in Search Console.',
                entityType: 'website',
                entityId: w.id,
                entityLabel: w.name,
                dedupeKey: `inspect:${f.id}`,
              });
            }
          }
        }
        if (w.gaId && scope !== 'search_console') {
          const end = await latestDate('analytics_daily_metrics', 'ga4_property_id', w.gaId);
          if (end) {
            const anchor = addDays(end, -1); // last complete day
            const cur = { start: addDays(anchor, -6), end: anchor };
            const prev = { start: addDays(anchor, -13), end: addDays(anchor, -7) };
            const [c, p] = await Promise.all([ga4Totals([w.gaId], cur), ga4Totals([w.gaId], prev)]);
            const chg = pctChange(c.sessions, p.sessions);
            if (chg != null && (p.sessions ?? 0) >= t.minClicksForAlert && chg <= -t.trafficDeclinePct) {
              await raise({
                type: 'traffic_decline',
                severity: chg <= -50 ? 'critical' : 'warning',
                title: `Website sessions down ${fmtPct(chg)} — ${w.name}`,
                description: `GA4 sessions ${p.sessions} → ${c.sessions} (${cur.start}…${cur.end} vs previous 7 days).`,
                recommendedAction: 'Open Traffic Analytics to see which channel (organic, direct, referral) declined.',
                entityType: 'website',
                entityId: w.id,
                entityLabel: w.name,
                dedupeKey: `ga_decline:${w.id}:${anchor}`,
              });
            }
          }
        }
      } catch (err) {
        logger.warn({ website: w.name, err: errorMessage(err) }, 'Alert evaluation failed for website');
      }
    }
  }

  // ---------- AdMob ----------
  if (scope === 'all' || scope === 'admob') {
    const end = await latestDate('admob_daily_metrics', 'admob_account_id');
    if (end) {
      const anchor = addDays(end, -1);
      const cur = { start: addDays(anchor, -6), end: anchor };
      const prev = { start: addDays(anchor, -13), end: addDays(anchor, -7) };
      const [c, p] = await Promise.all([admobTotals(cur), admobTotals(prev)]);
      for (const ct of c) {
        const pt = p.find((x) => x.currency === ct.currency);
        if (!pt) continue;
        const rev = pctChange(ct.earnings, pt.earnings);
        if (rev != null && (pt.earnings ?? 0) > 1 && rev <= -t.revenueDeclinePct) {
          await raise({
            type: 'revenue_decline',
            severity: rev <= -50 ? 'critical' : 'warning',
            title: `AdMob estimated earnings down ${fmtPct(rev)}`,
            description: `${pt.earnings?.toFixed(2)} → ${ct.earnings?.toFixed(2)} ${ct.currency} (${cur.start}…${cur.end} vs previous 7 days).`,
            recommendedAction: 'Open AdMob Revenue → by app and by country to locate the drop; check ad unit fill (match rate).',
            entityType: 'admob',
            dedupeKey: `rev_decline:${ct.currency}:${anchor}`,
          });
        }
        const ecpm = pctChange(ct.ecpm, pt.ecpm);
        if (ecpm != null && Math.abs(ecpm) >= t.ecpmChangePct && (pt.impressions ?? 0) >= 1000) {
          await raise({
            type: 'ecpm_change',
            severity: ecpm < 0 ? 'warning' : 'info',
            title: `eCPM ${ecpm < 0 ? 'fell' : 'rose'} ${fmtPct(ecpm)}`,
            description: `eCPM ${pt.ecpm?.toFixed(2)} → ${ct.ecpm?.toFixed(2)} ${ct.currency} (last 7 days vs previous 7).`,
            recommendedAction: ecpm < 0 ? 'Review country mix and ad formats; low-eCPM geographies or formats may have grown.' : 'Note what changed to replicate it.',
            entityType: 'admob',
            dedupeKey: `ecpm:${ct.currency}:${anchor}`,
          });
        }
      }
    }
  }

  // ---------- Play vitals ----------
  if (scope === 'all' || scope === 'play_reporting') {
    const apps = await db.select().from(playConsoleApps).where(eq(playConsoleApps.isSelected, true));
    for (const app of apps) {
      const [row] = await rawRows<{ d: string | null }>(sql`select max(metric_date)::text d from app_vitals where play_console_app_id = ${app.id}::uuid`);
      if (!row?.d) continue;
      const range = { start: addDays(row.d, -6), end: row.d };
      const vs = await vitalsSummary([app.id], range);
      const crash = vs.find((v) => v.metric === 'crashRate' && !v.slice)?.value ?? null;
      const anr = vs.find((v) => v.metric === 'anrRate' && !v.slice)?.value ?? null;
      const label = app.displayName ?? app.packageName;
      if (crash != null && crash >= t.crashRateWarning) {
        await raise({
          type: 'high_crash_rate',
          severity: crash >= t.crashRateCritical ? 'critical' : 'warning',
          title: `High crash rate ${crash.toFixed(2)}% — ${label}`,
          description: `7-day user-weighted crash rate is ${crash.toFixed(2)}% (threshold ${t.crashRateWarning}%), ${range.start}…${range.end}.`,
          recommendedAction: 'Open Android vitals → Crashes in Play Console, fix the top clusters and ship a patch release.',
          entityType: 'android_app',
          entityId: app.id,
          entityLabel: label,
          dedupeKey: `crash:${app.id}:${row.d}`,
        });
      }
      if (anr != null && anr >= t.anrRateWarning) {
        await raise({
          type: 'high_anr_rate',
          severity: anr >= t.anrRateCritical ? 'critical' : 'warning',
          title: `High ANR rate ${anr.toFixed(2)}% — ${label}`,
          description: `7-day user-weighted ANR rate is ${anr.toFixed(2)}% (threshold ${t.anrRateWarning}%), ${range.start}…${range.end}.`,
          recommendedAction: 'Move disk/network work off the main thread; review ANR clusters in Play Console.',
          entityType: 'android_app',
          entityId: app.id,
          entityLabel: label,
          dedupeKey: `anr:${app.id}:${row.d}`,
        });
      }
    }
  }

  // ---------- Connection problems ----------
  const svcs = await db.select().from(connectedServices).where(inArray(connectedServices.status, ['error', 'revoked']));
  for (const sv of svcs) {
    await raise({
      type: sv.service === 'ga4' ? 'ga4_connection' : sv.status === 'revoked' ? 'oauth_problem' : `${sv.service}_connection`,
      severity: sv.status === 'revoked' ? 'critical' : 'warning',
      title: `${sv.service.replace('_', ' ')} connection ${sv.status}`,
      description: sv.lastError ?? 'The integration reported an error.',
      recommendedAction: 'Open Integrations to reconnect or fix permissions.',
      entityType: 'integration',
      entityLabel: sv.service,
      dedupeKey: `conn:${sv.service}:${sv.status}:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  // properties that failed their last sync
  const failedSc = await db.select().from(searchConsoleProperties).where(and(eq(searchConsoleProperties.syncStatus, 'failed'), eq(searchConsoleProperties.isSelected, true)));
  const failedGa = await db.select().from(ga4Properties).where(and(eq(ga4Properties.syncStatus, 'failed'), eq(ga4Properties.isSelected, true)));
  for (const p of failedSc) {
    await raise({
      type: 'search_console_sync_failure',
      severity: 'warning',
      title: `Search Console sync failed — ${p.siteUrl}`,
      description: p.lastError ?? 'Unknown error',
      recommendedAction: 'Confirm the connected Google account still has access to this property.',
      entityType: 'search_console_property',
      entityId: p.id,
      entityLabel: p.siteUrl,
      dedupeKey: `scfail:${p.id}:${new Date().toISOString().slice(0, 10)}`,
    });
  }
  for (const p of failedGa) {
    await raise({
      type: 'ga4_connection',
      severity: 'warning',
      title: `GA4 sync failed — ${p.displayName}`,
      description: p.lastError ?? 'Unknown error',
      recommendedAction: 'Confirm the connected Google account has at least Viewer access to this GA4 property.',
      entityType: 'ga4_property',
      entityId: p.id,
      entityLabel: p.displayName,
      dedupeKey: `gafail:${p.id}:${new Date().toISOString().slice(0, 10)}`,
    });
  }
  return created;
}
