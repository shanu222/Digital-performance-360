/** Auth, Google connection, integrations, settings, sync, notifications, health. */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, pingDb } from '../db/client.js';
import {
  users,
  connectedServices,
  searchConsoleProperties,
  ga4Properties,
  admobAccounts,
  admobApps,
  playConsoleApps,
  notifications,
  syncJobs,
  syncLogs,
  websites,
} from '../db/schema.js';
import { env, isProd, googleOAuthConfigured } from '../config/env.js';
import { AppError, h, ok, parse, notFound } from '../lib/http.js';
import { requireAuth, csrfProtection, requireRole } from '../middleware/auth.js';
import { createSession, destroySession, verifyPassword, hashPassword, SESSION_COOKIE, SESSION_TTL_MS } from '../services/auth.js';
import {
  buildAuthUrl,
  handleCallback,
  disconnectGoogle,
  getActiveGoogleAccount,
  savePlayServiceAccount,
  removePlayServiceAccount,
  getPlayServiceAccount,
  ALL_OAUTH_SCOPES,
  PLAY_REPORTING_SCOPE,
} from '../services/google/oauth.js';
import { enqueue, recentJobs } from '../services/sync/queue.js';
import { getSettings, updateSettings } from '../services/settings.js';
import { sendEmail, emailConfigured } from '../services/email.js';
import { aiConfigured } from '../services/ai.js';
import { ensureWebsitesForSelected } from '../services/google/searchConsole.js';
import { errorMessage, logger } from '../lib/logger.js';
import { idParam } from './_shared.js';

export const health = Router();
health.get(
  '/',
  h(async (_req, res) => {
    const dbOk = await pingDb();
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, service: 'dp360-backend', db: dbOk ? 'up' : 'down', time: new Date().toISOString() });
  }),
);

/* ------------------------------- auth ------------------------------- */

export const auth = Router();
let dummyHash: string | undefined;
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: { code: 'rate_limited', message: 'Too many login attempts. Try again later.' } } });

const cookieOpts = () => ({
  httpOnly: true,
  secure: isProd,
  // Vercel and Railway are different sites, so the cookie must be SameSite=None in production
  sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
  maxAge: SESSION_TTL_MS,
});

auth.post(
  '/login',
  loginLimiter,
  h(async (req, res) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
    const [u] = await db.select().from(users).where(eq(users.email, body.email.toLowerCase()));
    // same error and similar timing whether or not the user exists
    dummyHash ??= await hashPassword('timing-equaliser');
    const valid = await verifyPassword(body.password, u ? u.passwordHash : dummyHash);
    if (!u || !valid || !u.isActive) throw new AppError(401, 'invalid_credentials', 'Incorrect email or password');
    const s = await createSession(u.id, { ip: req.ip, userAgent: req.get('user-agent') });
    res.cookie(SESSION_COOKIE, s.token, cookieOpts());
    ok(res, { user: { id: u.id, email: u.email, name: u.name, role: u.role }, csrfToken: s.csrfToken });
  }),
);

auth.post(
  '/logout',
  requireAuth,
  csrfProtection,
  h(async (req, res) => {
    await destroySession(req.cookies[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { ...cookieOpts(), maxAge: undefined });
    ok(res, { loggedOut: true });
  }),
);

auth.get(
  '/me',
  requireAuth,
  h(async (req, res) => ok(res, { user: req.user, csrfToken: req.csrfToken })),
);

auth.post(
  '/change-password',
  requireAuth,
  csrfProtection,
  h(async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string(), newPassword: z.string().min(12).max(200) }), req.body);
    const [u] = await db.select().from(users).where(eq(users.id, req.user!.id));
    if (!u || !(await verifyPassword(body.currentPassword, u.passwordHash))) throw new AppError(400, 'invalid_password', 'Current password is incorrect');
    await db.update(users).set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() }).where(eq(users.id, u.id));
    ok(res, { changed: true });
  }),
);

/* ------------------------------ google ------------------------------ */

export const google = Router();

/** OAuth callback: top-level redirect from Google — validated by single-use state, not the session. */
google.get(
  '/callback',
  h(async (req, res) => {
    const front = env.FRONTEND_URL.split(',')[0].replace(/\/$/, '');
    const q = req.query as Record<string, string | undefined>;
    if (q.error) return res.redirect(`${front}/onboarding?google=error&reason=${encodeURIComponent(q.error)}`);
    if (!q.code || !q.state) return res.redirect(`${front}/onboarding?google=error&reason=missing_code`);
    try {
      await handleCallback(q.code, q.state);
      await enqueue('discovery', { trigger: 'manual' });
      return res.redirect(`${front}/onboarding?google=connected`);
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'oauth_failed';
      logger.warn({ err: errorMessage(err) }, 'OAuth callback failed');
      return res.redirect(`${front}/onboarding?google=error&reason=${encodeURIComponent(code)}`);
    }
  }),
);

google.use(requireAuth, csrfProtection);

google.post(
  '/connect',
  h(async (req, res) => ok(res, { url: await buildAuthUrl(req.user!.id) })),
);

google.get(
  '/status',
  h(async (_req, res) => {
    const acct = await getActiveGoogleAccount();
    ok(res, {
      configured: googleOAuthConfigured,
      connected: Boolean(acct),
      email: acct?.google_accounts.email ?? null,
      status: acct?.google_accounts.status ?? null,
      grantedScopes: acct?.google_accounts.grantedScopes ?? [],
      requestedScopes: ALL_OAUTH_SCOPES,
      connectedAt: acct?.google_accounts.connectedAt ?? null,
      lastError: acct?.google_accounts.lastError ?? null,
    });
  }),
);

google.post(
  '/disconnect',
  h(async (_req, res) => {
    await disconnectGoogle();
    ok(res, { disconnected: true });
  }),
);

/* --------------------------- integrations --------------------------- */

export const integrations = Router();
integrations.use(requireAuth, csrfProtection);

integrations.get(
  '/',
  h(async (_req, res) => {
    const svcs = await db.select().from(connectedServices);
    const acct = await getActiveGoogleAccount();
    const play = await getPlayServiceAccount();
    const by = Object.fromEntries(svcs.map((s) => [s.service, { status: s.status, lastError: s.lastError, lastCheckedAt: s.lastCheckedAt, lastSuccessAt: s.lastSuccessAt, details: s.details }]));
    const [counts] = await db.execute(sql`
      select (select count(*) from search_console_properties)::int sc_total, (select count(*) from search_console_properties where is_selected)::int sc_selected,
             (select count(*) from ga4_properties)::int ga_total, (select count(*) from ga4_properties where is_selected)::int ga_selected,
             (select count(*) from admob_accounts)::int admob_accounts, (select count(*) from admob_apps)::int admob_apps,
             (select count(*) from play_console_apps)::int play_total, (select count(*) from play_console_apps where is_selected)::int play_selected`).then((r) => (r as unknown as { rows: Record<string, number>[] }).rows);
    ok(res, {
      google: { oauthConfigured: googleOAuthConfigured, connected: Boolean(acct), email: acct?.google_accounts.email ?? null, status: acct?.google_accounts.status ?? null, scopes: acct?.google_accounts.grantedScopes ?? [] },
      services: {
        search_console: by.search_console ?? { status: acct ? 'connected' : 'not_configured' },
        ga4: by.ga4 ?? { status: acct ? 'connected' : 'not_configured' },
        admob: by.admob ?? { status: acct ? 'connected' : 'not_configured' },
        play_reporting: { ...(by.play_reporting ?? { status: 'not_configured' }), serviceAccountEmail: play?.client_email ?? null, scope: PLAY_REPORTING_SCOPE },
        openai: { status: aiConfigured() ? 'connected' : 'not_configured', model: env.OPENAI_MODEL },
        email: { status: emailConfigured() ? 'connected' : 'not_configured', provider: env.EMAIL_PROVIDER },
      },
      counts,
    });
  }),
);

integrations.get(
  '/properties',
  h(async (_req, res) => {
    const [sc, ga, accts, apps, play] = await Promise.all([
      db.select().from(searchConsoleProperties).orderBy(searchConsoleProperties.siteUrl),
      db.select().from(ga4Properties).orderBy(ga4Properties.displayName),
      db.select().from(admobAccounts),
      db.select().from(admobApps).orderBy(admobApps.displayName),
      db.select().from(playConsoleApps).orderBy(playConsoleApps.displayName),
    ]);
    ok(res, { searchConsole: sc, ga4: ga, admobAccounts: accts, admobApps: apps, playApps: play });
  }),
);

integrations.post(
  '/discover',
  h(async (_req, res) => {
    const r = await enqueue('discovery', { trigger: 'manual' });
    ok(res, { job: r.job, created: r.created }, undefined, 202);
  }),
);

const selectBody = z.object({ isSelected: z.boolean() });

integrations.patch(
  '/search-console/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { isSelected } = parse(selectBody, req.body);
    const [row] = await db.update(searchConsoleProperties).set({ isSelected, updatedAt: new Date() }).where(eq(searchConsoleProperties.id, id)).returning();
    if (!row) throw notFound('Property');
    if (isSelected) {
      await ensureWebsitesForSelected();
      await enqueue('search_console', { targetId: id, trigger: 'manual' });
    }
    ok(res, row);
  }),
);

integrations.patch(
  '/ga4/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { isSelected } = parse(selectBody, req.body);
    const [row] = await db.update(ga4Properties).set({ isSelected, updatedAt: new Date() }).where(eq(ga4Properties.id, id)).returning();
    if (!row) throw notFound('Property');
    if (isSelected) await enqueue('ga4', { targetId: id, trigger: 'manual' });
    ok(res, row);
  }),
);

/** Manual GA4 property entry (e.g. when Admin API discovery is not permitted). */
integrations.post(
  '/ga4/manual',
  h(async (req, res) => {
    const body = parse(z.object({ propertyId: z.string().regex(/^(properties\/)?\d+$/), displayName: z.string().min(1).max(200) }), req.body);
    const name = body.propertyId.startsWith('properties/') ? body.propertyId : `properties/${body.propertyId}`;
    const [row] = await db
      .insert(ga4Properties)
      .values({ propertyName: name, displayName: body.displayName, source: 'manual', isSelected: true })
      .onConflictDoUpdate({ target: ga4Properties.propertyName, set: { displayName: body.displayName, isSelected: true, updatedAt: new Date() } })
      .returning();
    await enqueue('ga4', { targetId: row.id, trigger: 'manual' });
    ok(res, row, undefined, 201);
  }),
);

integrations.patch(
  '/admob/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { isSelected } = parse(selectBody, req.body);
    const [row] = await db.update(admobAccounts).set({ isSelected, updatedAt: new Date() }).where(eq(admobAccounts.id, id)).returning();
    if (!row) throw notFound('AdMob account');
    if (isSelected) await enqueue('admob', { targetId: id, trigger: 'manual' });
    ok(res, row);
  }),
);

integrations.patch(
  '/play/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { isSelected } = parse(selectBody, req.body);
    const [row] = await db.update(playConsoleApps).set({ isSelected, updatedAt: new Date() }).where(eq(playConsoleApps.id, id)).returning();
    if (!row) throw notFound('Play app');
    if (isSelected) await enqueue('play_reporting', { targetId: id, trigger: 'manual' });
    ok(res, row);
  }),
);

integrations.post(
  '/play-service-account',
  h(async (req, res) => {
    const body = parse(z.object({ json: z.string().min(50).max(20_000) }), req.body);
    const r = await savePlayServiceAccount(body.json);
    await enqueue('discovery', { trigger: 'manual' });
    ok(res, r);
  }),
);

integrations.delete(
  '/play-service-account',
  h(async (_req, res) => {
    await removePlayServiceAccount();
    ok(res, { removed: true });
  }),
);

/* ------------------------------ settings ----------------------------- */

export const settings = Router();
settings.use(requireAuth, csrfProtection);
settings.get('/', h(async (_req, res) => ok(res, { settings: await getSettings(), emailConfigured: emailConfigured(), aiConfigured: aiConfigured(), env: { timezone: env.APP_TIMEZONE, currency: env.DEFAULT_CURRENCY } })));
settings.put(
  '/',
  requireRole('admin'),
  h(async (req, res) => {
    try {
      ok(res, await updateSettings(req.body));
    } catch (err) {
      if (err instanceof z.ZodError) throw new AppError(422, 'validation_error', 'Invalid settings', z.treeifyError(err));
      throw err;
    }
  }),
);
settings.post(
  '/test-email',
  h(async (_req, res) => {
    const s = await getSettings();
    const r = await sendEmail({ to: s.email.recipients, subject: 'Digital Performance 360 — test email', html: '<p>Email delivery is working.</p>' });
    ok(res, r);
  }),
);

/* -------------------------------- sync -------------------------------- */

export const sync = Router();
sync.use(requireAuth, csrfProtection);

sync.get(
  '/status',
  h(async (_req, res) => {
    const active = await db.select().from(syncJobs).where(sql`status in ('pending','running')`).orderBy(desc(syncJobs.createdAt));
    const last = await db.execute(sql`
      select distinct on (service) service, status, finished_at, error from sync_jobs
      where status in ('success','partial','failed') order by service, finished_at desc nulls last`);
    const lastSuccess = await db.execute(sql`
      select service, max(finished_at) finished_at from sync_jobs where status in ('success','partial') group by service`);
    ok(res, { active, last: (last as unknown as { rows: unknown[] }).rows, lastSuccess: (lastSuccess as unknown as { rows: unknown[] }).rows });
  }),
);

sync.get('/jobs', h(async (req, res) => ok(res, await recentJobs(Math.min(Number(req.query.limit ?? 50), 200)))));

sync.get(
  '/jobs/:id/logs',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    ok(res, await db.select().from(syncLogs).where(eq(syncLogs.jobId, id)).orderBy(syncLogs.id));
  }),
);

sync.post(
  '/run',
  h(async (req, res) => {
    const body = parse(
      z.object({
        service: z.enum(['discovery', 'search_console', 'ga4', 'admob', 'play_reporting', 'alerts', 'ai_analysis', 'daily_report']),
        targetId: z.string().max(100).optional(),
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      req.body,
    );
    const params: Record<string, unknown> = {};
    if (body.start) params.start = body.start;
    if (body.end) params.end = body.end;
    const r = await enqueue(body.service, { targetId: body.targetId, trigger: body.start ? 'backfill' : 'manual', params });
    ok(res, r, undefined, 202);
  }),
);

/** Sync every connected service for a website (Search Console + GA4). */
sync.post(
  '/website/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const [w] = await db.select().from(websites).where(eq(websites.id, id));
    if (!w) throw notFound('Website');
    const jobs = [];
    if (w.searchConsolePropertyId) jobs.push((await enqueue('search_console', { targetId: w.searchConsolePropertyId, trigger: 'manual' })).job);
    if (w.ga4PropertyId) jobs.push((await enqueue('ga4', { targetId: w.ga4PropertyId, trigger: 'manual' })).job);
    ok(res, { jobs }, undefined, 202);
  }),
);

/* ---------------------------- notifications ---------------------------- */

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth, csrfProtection);

notificationsRouter.get(
  '/',
  h(async (req, res) => {
    const q = parse(
      z.object({ unread: z.enum(['true', 'false']).optional(), severity: z.enum(['critical', 'warning', 'info']).optional(), limit: z.coerce.number().min(1).max(200).default(50), offset: z.coerce.number().min(0).default(0) }),
      req.query,
    );
    const conds = [];
    if (q.unread === 'true') conds.push(eq(notifications.isRead, false));
    if (q.severity) conds.push(eq(notifications.severity, q.severity));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(q.limit).offset(q.offset);
    const [{ unread }] = (await db.execute(sql`select count(*)::int unread from notifications where not is_read`).then((r) => (r as unknown as { rows: Array<{ unread: number }> }).rows));
    ok(res, rows, { unread });
  }),
);

notificationsRouter.patch(
  '/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { isRead } = parse(z.object({ isRead: z.boolean() }), req.body);
    const [row] = await db.update(notifications).set({ isRead }).where(eq(notifications.id, id)).returning();
    if (!row) throw notFound('Notification');
    ok(res, row);
  }),
);

notificationsRouter.post(
  '/read-all',
  h(async (_req, res) => {
    await db.update(notifications).set({ isRead: true }).where(eq(notifications.isRead, false));
    ok(res, { done: true });
  }),
);

notificationsRouter.delete(
  '/:id',
  h(async (req, res) => {
    const { id } = parse(idParam, req.params);
    await db.delete(notifications).where(eq(notifications.id, id));
    ok(res, { deleted: true });
  }),
);
