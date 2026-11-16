/**
 * Connects the same real-world website/app across services:
 *  - GA4 web data streams  → websites (by domain)
 *  - GA4 Android streams   → android_apps (by package name)
 *  - Search Console        → websites (by domain)
 * so every website/app dashboard shows SEO, traffic, stability and revenue together.
 */
import { eq, isNull, and } from 'drizzle-orm';
import { google, type analyticsadmin_v1beta } from 'googleapis';
import { db } from '../db/client.js';
import { ga4Properties, websites, androidApps, searchConsoleProperties } from '../db/schema.js';
import { getAuthedClient } from './google/oauth.js';
import { withRetry } from '../lib/retry.js';
import { errorMessage, logger } from '../lib/logger.js';

export const normalizeDomain = (d: string) =>
  d.trim().toLowerCase().replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

/** Reads the data streams of every GA4 property (web URLs and Android package names). */
export async function discoverGa4Streams(client?: analyticsadmin_v1beta.Analyticsadmin) {
  const props = await db.select().from(ga4Properties).where(eq(ga4Properties.isAccessible, true));
  const clients = new Map<string, analyticsadmin_v1beta.Analyticsadmin>();
  let streams = 0;
  for (const p of props) {
    try {
      const key = p.googleAccountId ?? 'default';
      if (!client && !clients.has(key)) clients.set(key, google.analyticsadmin({ version: 'v1beta', auth: await getAuthedClient(p.googleAccountId) }));
      const admin = client ?? clients.get(key)!;
      const res = await withRetry(() => admin.properties.dataStreams.list({ parent: p.propertyName, pageSize: 200 }), { label: 'ga4.dataStreams' });
      const web = new Set<string>();
      const pkgs = new Set<string>();
      for (const s of res.data.dataStreams ?? []) {
        streams++;
        if (s.webStreamData?.defaultUri) web.add(normalizeDomain(s.webStreamData.defaultUri));
        if (s.androidAppStreamData?.packageName) pkgs.add(s.androidAppStreamData.packageName);
      }
      await db
        .update(ga4Properties)
        .set({ webDomains: [...web].filter(Boolean), androidPackages: [...pkgs], updatedAt: new Date() })
        .where(eq(ga4Properties.id, p.id));
    } catch (err) {
      logger.warn({ property: p.propertyName, err: errorMessage(err) }, 'Could not read GA4 data streams');
    }
  }
  return streams;
}

/**
 * Links and creates records. Only SELECTED GA4 properties create new websites/apps;
 * existing websites/apps are linked to any matching GA4 property.
 */
export async function linkEntities() {
  const ga = await db.select().from(ga4Properties);
  const sites = await db.select().from(websites);
  const apps = await db.select().from(androidApps);
  let linked = 0;
  let created = 0;

  // 1. existing websites without GA4 → link by domain
  for (const w of sites) {
    if (w.ga4PropertyId) continue;
    const match = ga.find((g) => g.webDomains.includes(normalizeDomain(w.domain)));
    if (match) {
      await db.update(websites).set({ ga4PropertyId: match.id, updatedAt: new Date() }).where(eq(websites.id, w.id));
      if (!match.isSelected) await db.update(ga4Properties).set({ isSelected: true }).where(eq(ga4Properties.id, match.id));
      linked++;
    }
  }

  // 2. selected GA4 properties with a web stream but no website → create website
  const fresh = await db.select().from(websites);
  for (const g of ga.filter((x) => x.isSelected)) {
    for (const domain of g.webDomains) {
      if (fresh.some((w) => normalizeDomain(w.domain) === domain)) continue;
      // attach the Search Console property for that domain too, if one exists
      const sc = (await db.select().from(searchConsoleProperties)).find((s) => normalizeDomain(s.siteUrl) === domain && s.isAccessible);
      await db
        .insert(websites)
        .values({ name: domain, domain, ga4PropertyId: g.id, searchConsolePropertyId: sc?.id ?? null })
        .onConflictDoNothing({ target: websites.domain });
      if (sc && !sc.isSelected) await db.update(searchConsoleProperties).set({ isSelected: true }).where(eq(searchConsoleProperties.id, sc.id));
      fresh.push({ domain } as typeof fresh[number]);
      created++;
    }
  }

  // 3. Android apps ↔ GA4/Firebase Android streams by package name
  for (const a of apps) {
    if (a.ga4PropertyId) continue;
    const match = ga.find((g) => g.androidPackages.includes(a.packageName));
    if (match) {
      await db.update(androidApps).set({ ga4PropertyId: match.id, updatedAt: new Date() }).where(eq(androidApps.id, a.id));
      if (!match.isSelected) await db.update(ga4Properties).set({ isSelected: true }).where(eq(ga4Properties.id, match.id));
      linked++;
    }
  }
  for (const g of ga.filter((x) => x.isSelected)) {
    for (const pkg of g.androidPackages) {
      if (apps.some((a) => a.packageName === pkg)) continue;
      await db
        .insert(androidApps)
        .values({ name: g.displayName, packageName: pkg, ga4PropertyId: g.id, source: 'discovered' })
        .onConflictDoNothing({ target: androidApps.packageName });
      apps.push({ packageName: pkg } as typeof apps[number]);
      created++;
    }
  }

  // 4. websites whose Search Console property is missing → link by domain
  const scProps = await db.select().from(searchConsoleProperties).where(eq(searchConsoleProperties.isAccessible, true));
  for (const w of await db.select().from(websites).where(isNull(websites.searchConsolePropertyId))) {
    const d = normalizeDomain(w.domain);
    // prefer the domain property, then URL-prefix
    const sc = scProps.find((s) => s.siteUrl === `sc-domain:${d}`) ?? scProps.find((s) => normalizeDomain(s.siteUrl) === d);
    if (sc) {
      await db.update(websites).set({ searchConsolePropertyId: sc.id, updatedAt: new Date() }).where(and(eq(websites.id, w.id)));
      if (!sc.isSelected) await db.update(searchConsoleProperties).set({ isSelected: true }).where(eq(searchConsoleProperties.id, sc.id));
      linked++;
    }
  }
  return { linked, created };
}
