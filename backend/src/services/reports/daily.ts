import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { dailyReports, websites, androidApps, admobApps, aiInsights, sitemapRecords, reportFiles } from '../../db/schema.js';
import { addDays, pctChange, prevMonthRange } from '../../lib/dates.js';
import { errorMessage, logger } from '../../lib/logger.js';
import { getSettings } from '../settings.js';
import { seoTotals, dimensionTable, breakdown, ga4Totals, admobTotals, admobGrouped, vitalsSummary, classifyHealth } from '../metrics.js';
import { sendEmail, emailConfigured } from '../email.js';
import { escapeHtml } from '../alerts.js';
import { buildReport } from './builder.js';
import { renderPdf } from './render.js';

/**
 * Daily report for one reporting date: per website and per app, with the
 * previous day as comparison. All values come from stored data.
 */
export async function generateDailyReport(date: string, opts: { email?: boolean } = {}) {
  const day = { start: date, end: date };
  const prevDay = { start: addDays(date, -1), end: addDays(date, -1) };
  const sites = await db.select().from(websites).where(eq(websites.isMonitored, true));
  const apps = await db.select().from(androidApps).where(eq(androidApps.isMonitored, true));
  const s = await getSettings();

  const siteReports = [];
  for (const w of sites) {
    const sc = w.searchConsolePropertyId ? [w.searchConsolePropertyId] : [];
    const ga = w.ga4PropertyId ? [w.ga4PropertyId] : [];
    const [c, p, kw, pages, gc, gp, countries, channels, devices] = await Promise.all([
      seoTotals(sc, day),
      seoTotals(sc, prevDay),
      dimensionTable('query', sc, day, prevDay, { limit: 5 }),
      dimensionTable('page', sc, day, prevDay, { limit: 5 }),
      ga4Totals(ga, day),
      ga4Totals(ga, prevDay),
      breakdown('ga4', ga, 'country', day, 5),
      breakdown('ga4', ga, 'channel', day, 6),
      breakdown('ga4', ga, 'device', day, 3),
    ]);
    const maps = sc.length ? await db.select().from(sitemapRecords).where(eq(sitemapRecords.searchConsolePropertyId, sc[0])) : [];
    const insights = await db
      .select()
      .from(aiInsights)
      .where(and(eq(aiInsights.entityType, 'website'), eq(aiInsights.entityId, w.id), eq(aiInsights.generatedForDate, date)));
    siteReports.push({
      id: w.id,
      name: w.name,
      domain: w.domain,
      seo: sc.length
        ? {
            clicks: c.clicks,
            impressions: c.impressions,
            ctr: c.ctr,
            position: c.position,
            preliminary: c.freshDays > 0,
            clicksChangePct: pctChange(c.clicks, p.clicks),
            impressionsChangePct: pctChange(c.impressions, p.impressions),
            topKeywords: kw.rows.map((r) => ({ key: r.key, clicks: r.clicks, position: r.position })),
            topPages: pages.rows.map((r) => ({ key: r.key, clicks: r.clicks })),
          }
        : null,
      traffic: ga.length
        ? {
            activeUsers: gc.activeUsersDailySum,
            newUsers: gc.newUsers,
            sessions: gc.sessions,
            sessionsChangePct: pctChange(gc.sessions, gp.sessions),
            topCountries: countries.map((x) => ({ key: x.value, sessions: x.sessions })),
            channels: channels.map((x) => ({ key: x.value, sessions: x.sessions })),
            devices: devices.map((x) => ({ key: x.value, sessions: x.sessions })),
          }
        : null,
      technical: { sitemaps: maps.map((m) => ({ path: m.path, errors: m.errors, warnings: m.warnings })) },
      ai: insights.map((i) => ({ title: i.title, priority: i.priority, action: i.recommendedAction, category: i.category })),
    });
  }

  const appReports = [];
  for (const a of apps) {
    const [am] = a.admobAppId ? await db.select().from(admobApps).where(eq(admobApps.id, a.admobAppId)) : [];
    const weekRange = { start: addDays(date, -8), end: addDays(date, -2) }; // Play lags ~2 days
    const vit = a.playConsoleAppId ? await vitalsSummary([a.playConsoleAppId], weekRange) : [];
    const m = (k: string) => vit.find((v) => v.metric === k && !v.slice)?.value ?? null;
    const ga = a.ga4PropertyId ? await ga4Totals([a.ga4PropertyId], day) : null;
    const ad = am ? await admobTotals(day, [am.appId]) : [];
    const adCountries = am ? await admobGrouped('country', day, [am.appId]) : [];
    appReports.push({
      id: a.id,
      name: a.name,
      packageName: a.packageName,
      activeUsers: ga?.activeUsersDailySum ?? null,
      engagementRate: ga?.engagementRate ?? null,
      vitals: a.playConsoleAppId ? { period: weekRange, crashRate: m('crashRate'), anrRate: m('anrRate'), errorReports: m('errorReportCount'), status: classifyHealth(m('crashRate'), m('anrRate'), s.thresholds) } : null,
      admob: ad.map((x) => ({ currency: x.currency, earnings: x.earnings, impressions: x.impressions, clicks: x.clicks, ecpm: x.ecpm })),
      admobTopCountries: adCountries.slice(0, 5).map((x) => ({ key: x.key, earnings: x.earnings, currency: x.currency })),
    });
  }

  const admob = await admobTotals(day);
  const admobPrev = await admobTotals(prevDay);
  const content = {
    reportDate: date,
    timezone: s.general.timezone,
    websites: siteReports,
    apps: appReports,
    admob: admob.map((x) => ({ ...x, earningsChangePct: pctChange(x.earnings, admobPrev.find((p) => p.currency === x.currency)?.earnings) })),
    notes: [
      'Search Console data for the most recent days may be preliminary.',
      'AdMob earnings are estimates until finalised by Google.',
      'Android vitals cover the 7 most recent days available (Play data lags about 2 days).',
    ],
  };
  const [row] = await db
    .insert(dailyReports)
    .values({ reportDate: date, content })
    .onConflictDoUpdate({ target: dailyReports.reportDate, set: { content, generatedAt: new Date() } })
    .returning();

  let emailed = false;
  if (opts.email !== false && s.email.enabled && s.email.daily && s.email.recipients.length && emailConfigured()) {
    try {
      await sendEmail({ to: s.email.recipients, subject: `Daily Digital Performance Report — ${date}`, html: dailyEmailHtml(content) });
      await db.update(dailyReports).set({ emailedAt: new Date(), emailError: null }).where(eq(dailyReports.id, row.id));
      emailed = true;
    } catch (err) {
      const msg = errorMessage(err);
      await db.update(dailyReports).set({ emailError: msg }).where(eq(dailyReports.id, row.id));
      logger.warn({ err: msg }, 'Daily report email failed');
    }
  }
  return { id: row.id, date, websites: siteReports.length, apps: appReports.length, emailed };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DailyContent = Record<string, any>;

const fmt = (v: number | null | undefined, d = 0) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const ch = (v: number | null | undefined) =>
  v == null ? '' : `<span style="color:${v < 0 ? '#b91c1c' : '#15803d'}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`;

export function dailyEmailHtml(c: DailyContent): string {
  const section = (title: string, body: string) => `<h3 style="margin:18px 0 6px;color:#0b1324;font-size:14px;border-bottom:2px solid #d4a017;display:inline-block">${title}</h3>${body}`;
  const sites = (c.websites as any[])
    .map(
      (w) => `
      <div style="border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin:12px 0">
        <div style="font-weight:700;font-size:15px">${escapeHtml(w.name)} <span style="color:#64748b;font-weight:400">${escapeHtml(w.domain)}</span></div>
        ${
          w.seo
            ? section(
                'SEO performance',
                `<p style="margin:4px 0">Clicks <b>${fmt(w.seo.clicks)}</b> ${ch(w.seo.clicksChangePct)} · Impressions <b>${fmt(w.seo.impressions)}</b> ${ch(w.seo.impressionsChangePct)} · CTR <b>${w.seo.ctr == null ? '—' : (w.seo.ctr * 100).toFixed(2) + '%'}</b> · Avg position <b>${fmt(w.seo.position, 1)}</b>${w.seo.preliminary ? ' <i style="color:#64748b">(preliminary)</i>' : ''}</p>
                 <p style="margin:4px 0;color:#334155">Top keywords: ${(w.seo.topKeywords as any[]).map((k) => `${escapeHtml(k.key)} (${fmt(k.clicks)})`).join(', ') || '—'}</p>
                 <p style="margin:4px 0;color:#334155">Top pages: ${(w.seo.topPages as any[]).map((k) => `${escapeHtml(k.key)} (${fmt(k.clicks)})`).join(', ') || '—'}</p>`,
              )
            : '<p style="color:#64748b">Search Console not connected.</p>'
        }
        ${
          w.traffic
            ? section(
                'Traffic performance',
                `<p style="margin:4px 0">Active users <b>${fmt(w.traffic.activeUsers)}</b> · New users <b>${fmt(w.traffic.newUsers)}</b> · Sessions <b>${fmt(w.traffic.sessions)}</b> ${ch(w.traffic.sessionsChangePct)}</p>
                 <p style="margin:4px 0;color:#334155">Countries: ${(w.traffic.topCountries as any[]).map((k) => `${escapeHtml(k.key)} (${fmt(k.sessions)})`).join(', ') || '—'}</p>
                 <p style="margin:4px 0;color:#334155">Sources: ${(w.traffic.channels as any[]).map((k) => `${escapeHtml(k.key)} (${fmt(k.sessions)})`).join(', ') || '—'}</p>
                 <p style="margin:4px 0;color:#334155">Devices: ${(w.traffic.devices as any[]).map((k) => `${escapeHtml(k.key)} (${fmt(k.sessions)})`).join(', ') || '—'}</p>`,
              )
            : '<p style="color:#64748b">GA4 not connected.</p>'
        }
        ${section('Technical status', (w.technical.sitemaps as any[]).length ? (w.technical.sitemaps as any[]).map((m) => `<div>${escapeHtml(m.path)} — errors ${m.errors ?? 0}, warnings ${m.warnings ?? 0}</div>`).join('') : '<p style="color:#64748b">No sitemap data.</p>')}
        ${(w.ai as any[]).length ? section('AI analysis', `<ul>${(w.ai as any[]).map((i) => `<li><b>[${escapeHtml(i.priority)}]</b> ${escapeHtml(i.title)} — ${escapeHtml(i.action)}</li>`).join('')}</ul>`) : ''}
      </div>`,
    )
    .join('');
  const apps = (c.apps as any[])
    .map(
      (a) => `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin:12px 0">
        <div style="font-weight:700">${escapeHtml(a.name)} <span style="color:#64748b;font-weight:400">${escapeHtml(a.packageName)}</span></div>
        <p style="margin:4px 0">Active users <b>${fmt(a.activeUsers)}</b>${a.vitals ? ` · Crash rate <b>${fmt(a.vitals.crashRate, 2)}%</b> · ANR rate <b>${fmt(a.vitals.anrRate, 2)}%</b> · Status <b>${escapeHtml(String(a.vitals.status).replace('_', ' '))}</b>` : ''}</p>
        ${(a.admob as any[]).map((x) => `<p style="margin:4px 0">AdMob: <b>${x.currency} ${fmt(x.earnings, 2)}</b> est. · ${fmt(x.impressions)} impressions · ${fmt(x.clicks)} clicks · eCPM ${fmt(x.ecpm, 2)}</p>`).join('')}
      </div>`,
    )
    .join('');
  const admob = (c.admob as any[]).map((x) => `<b>${x.currency} ${fmt(x.earnings, 2)}</b> ${ch(x.earningsChangePct)} · eCPM ${fmt(x.ecpm, 2)} · ${fmt(x.impressions)} impressions`).join('<br/>');
  return `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;background:#f8fafc;margin:0;padding:20px;color:#0f172a">
  <div style="max-width:720px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
    <div style="background:#0b1324;padding:20px 24px;color:#fff">
      <div style="color:#06b6d4;font-size:11px;letter-spacing:2px;font-weight:700">DIGITAL PERFORMANCE 360</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px">Daily Digital Performance Report</div>
      <div style="color:#cbd5e1;font-size:12px">Reporting date: ${escapeHtml(c.reportDate)} (${escapeHtml(c.timezone)})</div>
    </div>
    <div style="padding:8px 24px 24px">
      ${admob ? section('AdMob portfolio (estimated)', `<p>${admob}</p>`) : ''}
      ${section('Websites', sites || '<p style="color:#64748b">No monitored websites.</p>')}
      ${section('Android applications', apps || '<p style="color:#64748b">No monitored apps.</p>')}
      <p style="color:#64748b;font-size:11px;margin-top:20px">${(c.notes as string[]).map(escapeHtml).join('<br/>')}</p>
    </div>
  </div></body></html>`;
}

/** Weekly / monthly summary: renders the portfolio report as a PDF attachment. */
export async function sendSummaryEmail(kind: 'weekly' | 'monthly', anchor: string) {
  const s = await getSettings();
  const cur = kind === 'weekly' ? { start: addDays(anchor, -6), end: anchor } : prevMonthRange(addDays(anchor, 1));
  const len = kind === 'weekly' ? 7 : 0;
  const prev = kind === 'weekly' ? { start: addDays(cur.start, -len), end: addDays(cur.start, -1) } : prevMonthRange(cur.start);
  const doc = await buildReport(kind === 'monthly' ? 'monthly_executive' : 'portfolio', cur, prev);
  doc.title = kind === 'weekly' ? 'Weekly Portfolio Summary' : 'Monthly Executive Summary';
  const pdf = await renderPdf(doc);
  const fileName = `dp360-${kind}-${cur.start}_${cur.end}.pdf`;
  await db.insert(reportFiles).values({ reportType: kind === 'monthly' ? 'monthly_executive' : 'portfolio', format: 'pdf', title: doc.title, params: { range: cur, kind }, fileName, mimeType: 'application/pdf', sizeBytes: pdf.length, content: pdf });
  if (!s.email.enabled || !s.email.recipients.length || !emailConfigured()) return { emailed: false, fileName };
  await sendEmail({
    to: s.email.recipients,
    subject: `${doc.title} — ${cur.start} to ${cur.end}`,
    html: `<p>Your ${kind} summary for ${cur.start} to ${cur.end} is attached.</p><ul>${doc.executiveSummary.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    attachments: [{ filename: fileName, content: pdf, contentType: 'application/pdf' }],
  });
  return { emailed: true, fileName };
}

export async function listDailyReports(limit = 60) {
  return db
    .select({ id: dailyReports.id, reportDate: dailyReports.reportDate, generatedAt: dailyReports.generatedAt, emailedAt: dailyReports.emailedAt, emailError: dailyReports.emailError })
    .from(dailyReports)
    .orderBy(desc(dailyReports.reportDate))
    .limit(limit);
}
