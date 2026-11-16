import { OAuth2Client, GoogleAuth, type JWTInput } from 'google-auth-library';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { googleAccounts, oauthCredentials, oauthStates, connectedServices, searchConsoleProperties, ga4Properties, admobAccounts } from '../../db/schema.js';
import { env, googleOAuthConfigured } from '../../config/env.js';
import { decrypt, encrypt, randomToken } from '../../lib/crypto.js';
import { AppError } from '../../lib/http.js';
import { errorMessage, logger } from '../../lib/logger.js';

/** Minimum read-only scopes. No Gmail, Drive or write scopes are ever requested. */
export const GOOGLE_SCOPES = {
  identity: ['openid', 'https://www.googleapis.com/auth/userinfo.email'],
  searchConsole: ['https://www.googleapis.com/auth/webmasters.readonly'],
  analytics: ['https://www.googleapis.com/auth/analytics.readonly'],
  admob: ['https://www.googleapis.com/auth/admob.readonly', 'https://www.googleapis.com/auth/admob.report'],
} as const;

export const PLAY_REPORTING_SCOPE = 'https://www.googleapis.com/auth/playdeveloperreporting';

export const ALL_OAUTH_SCOPES = [
  ...GOOGLE_SCOPES.identity,
  ...GOOGLE_SCOPES.searchConsole,
  ...GOOGLE_SCOPES.analytics,
  ...GOOGLE_SCOPES.admob,
];

export function newOAuthClient() {
  if (!googleOAuthConfigured) {
    throw new AppError(
      503,
      'google_not_configured',
      'Google OAuth is not configured on the server. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.',
    );
  }
  return new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  });
}

/** Step 1: build the consent URL with a single-use state (CSRF) and PKCE verifier stored server-side. */
export async function buildAuthUrl(userId: string) {
  const client = newOAuthClient();
  const state = randomToken(24);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
  await db.insert(oauthStates).values({
    state,
    userId,
    codeVerifier: encrypt(codeVerifier!),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account', // refresh token on every connect + let the admin pick another Google account
    include_granted_scopes: true,
    scope: ALL_OAUTH_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256' as never,
  });
}

/** Step 2: validate state, exchange code, encrypt + persist tokens. */
export async function handleCallback(code: string, state: string) {
  const [row] = await db
    .select()
    .from(oauthStates)
    .where(and(eq(oauthStates.state, state), gt(oauthStates.expiresAt, new Date())));
  // single use, regardless of outcome
  await db.delete(oauthStates).where(eq(oauthStates.state, state));
  if (!row) throw new AppError(400, 'invalid_state', 'OAuth state is invalid or expired. Please try connecting again.');

  const client = newOAuthClient();
  const { tokens } = await client.getToken({ code, codeVerifier: decrypt(row.codeVerifier) });
  if (!tokens.id_token) throw new AppError(400, 'oauth_failed', 'Google did not return an identity token');
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.sub) throw new AppError(400, 'oauth_failed', 'Could not verify Google identity');

  const granted = (tokens.scope ?? '').split(' ').filter(Boolean);

  const [account] = await db
    .insert(googleAccounts)
    .values({ userId: row.userId, googleSub: payload.sub, email: payload.email ?? null, grantedScopes: granted, status: 'active' })
    .onConflictDoUpdate({
      target: googleAccounts.googleSub,
      set: { userId: row.userId, email: payload.email ?? null, grantedScopes: granted, status: 'active', lastError: null, updatedAt: new Date() },
    })
    .returning();

  const existing = await db.select().from(oauthCredentials).where(eq(oauthCredentials.googleAccountId, account.id));
  const refresh = tokens.refresh_token ?? (existing[0] ? decrypt(existing[0].encryptedRefreshToken) : null);
  if (!refresh) {
    throw new AppError(
      400,
      'no_refresh_token',
      'Google did not issue a refresh token. Remove the app at myaccount.google.com/permissions and connect again.',
    );
  }
  const values = {
    googleAccountId: account.id,
    encryptedRefreshToken: encrypt(refresh),
    encryptedAccessToken: tokens.access_token ? encrypt(tokens.access_token) : null,
    accessTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    updatedAt: new Date(),
  };
  await db.insert(oauthCredentials).values(values).onConflictDoUpdate({ target: oauthCredentials.googleAccountId, set: values });

  await refreshServiceStatusFromScopes(granted);
  return { accountId: account.id, email: payload.email, scopes: granted };
}

async function upsertService(service: string, patch: Partial<typeof connectedServices.$inferInsert>) {
  await db
    .insert(connectedServices)
    .values({ service, ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({ target: connectedServices.service, set: { ...patch, updatedAt: new Date() } });
}

export async function setServiceStatus(
  service: string,
  status: string,
  opts: { error?: string | null; details?: Record<string, unknown>; success?: boolean } = {},
) {
  await upsertService(service, {
    status,
    lastError: opts.error ?? null,
    lastCheckedAt: new Date(),
    ...(opts.success ? { lastSuccessAt: new Date() } : {}),
    ...(opts.details ? { details: opts.details } : {}),
  });
}

async function refreshServiceStatusFromScopes(granted: string[]) {
  const has = (scopes: readonly string[]) => scopes.every((s) => granted.includes(s));
  await setServiceStatus('search_console', has(GOOGLE_SCOPES.searchConsole) ? 'connected' : 'needs_setup', {
    error: has(GOOGLE_SCOPES.searchConsole) ? null : 'Search Console permission was not granted',
  });
  await setServiceStatus('ga4', has(GOOGLE_SCOPES.analytics) ? 'connected' : 'needs_setup', {
    error: has(GOOGLE_SCOPES.analytics) ? null : 'Analytics permission was not granted',
  });
  await setServiceStatus('admob', has(GOOGLE_SCOPES.admob) ? 'connected' : 'needs_setup', {
    error: has(GOOGLE_SCOPES.admob) ? null : 'AdMob permission was not granted',
  });
}

/** All connected Google accounts with their (encrypted) credentials. */
export async function listGoogleAccounts() {
  return db
    .select()
    .from(googleAccounts)
    .innerJoin(oauthCredentials, eq(oauthCredentials.googleAccountId, googleAccounts.id))
    .orderBy(googleAccounts.connectedAt);
}

export async function activeGoogleAccounts() {
  return (await listGoogleAccounts()).filter((a) => a.google_accounts.status !== 'revoked');
}

/** First connected account (kept for callers that only need "is Google connected"). */
export async function getActiveGoogleAccount() {
  const all = await listGoogleAccounts();
  return all.find((a) => a.google_accounts.status !== 'revoked') ?? all[0] ?? null;
}

/**
 * OAuth2 client for a specific connected account (the one that can access the
 * property being read). Falls back to the first active account when not given.
 * google-auth-library refreshes access tokens; new tokens are persisted encrypted.
 */
export async function getAuthedClient(accountId?: string | null): Promise<OAuth2Client> {
  const all = await listGoogleAccounts();
  const acct = accountId ? all.find((a) => a.google_accounts.id === accountId) : all.find((a) => a.google_accounts.status !== 'revoked');
  if (!acct) throw new AppError(409, 'google_not_connected', accountId ? 'The Google account for this property is no longer connected' : 'Google account is not connected');
  if (acct.google_accounts.status === 'revoked') {
    throw new AppError(409, 'google_revoked', `Google access for ${acct.google_accounts.email ?? 'this account'} was revoked. Reconnect it on the Integrations page.`);
  }
  const client = newOAuthClient();
  const cred = acct.oauth_credentials;
  client.setCredentials({
    refresh_token: decrypt(cred.encryptedRefreshToken),
    access_token: cred.encryptedAccessToken ? decrypt(cred.encryptedAccessToken) : undefined,
    expiry_date: cred.accessTokenExpiresAt?.getTime(),
  });
  client.on('tokens', (t) => {
    const patch: Partial<typeof oauthCredentials.$inferInsert> = { updatedAt: new Date() };
    if (t.access_token) patch.encryptedAccessToken = encrypt(t.access_token);
    if (t.expiry_date) patch.accessTokenExpiresAt = new Date(t.expiry_date);
    if (t.refresh_token) patch.encryptedRefreshToken = encrypt(t.refresh_token);
    db.update(oauthCredentials)
      .set(patch)
      .where(eq(oauthCredentials.id, cred.id))
      .catch((err) => logger.error({ err: errorMessage(err) }, 'Failed to persist refreshed token'));
  });
  return client;
}

/** Called when Google answers invalid_grant / 401 for one account. */
export async function markGoogleRevoked(reason: string, accountId?: string | null) {
  await db
    .update(googleAccounts)
    .set({ status: 'revoked', lastError: reason, updatedAt: new Date() })
    .where(accountId ? eq(googleAccounts.id, accountId) : undefined);
  const remaining = await activeGoogleAccounts();
  if (!remaining.length) for (const s of ['search_console', 'ga4', 'admob']) await setServiceStatus(s, 'revoked', { error: reason });
}

/** Disconnect one account (or all): revoke at Google (best effort) and delete stored credentials. History is kept. */
export async function disconnectGoogle(accountId?: string) {
  const all = await listGoogleAccounts();
  const targets = accountId ? all.filter((a) => a.google_accounts.id === accountId) : all;
  for (const acct of targets) {
    try {
      await newOAuthClient().revokeToken(decrypt(acct.oauth_credentials.encryptedRefreshToken));
    } catch (err) {
      logger.warn({ err: errorMessage(err) }, 'Token revocation at Google failed (continuing with local removal)');
    }
    // properties only this account could read become inaccessible until another account rediscovers them
    await db.update(searchConsoleProperties).set({ isAccessible: false }).where(eq(searchConsoleProperties.googleAccountId, acct.google_accounts.id));
    await db.update(ga4Properties).set({ isAccessible: false }).where(eq(ga4Properties.googleAccountId, acct.google_accounts.id));
    await db.update(admobAccounts).set({ isSelected: false }).where(eq(admobAccounts.googleAccountId, acct.google_accounts.id));
    await db.delete(googleAccounts).where(eq(googleAccounts.id, acct.google_accounts.id));
  }
  if (!(await listGoogleAccounts()).length) for (const s of ['search_console', 'ga4', 'admob']) await setServiceStatus(s, 'not_configured');
}

/* ---------------- Play Developer Reporting service account ---------------- */

export async function getPlayServiceAccount(): Promise<JWTInput | null> {
  const [svc] = await db.select().from(connectedServices).where(eq(connectedServices.service, 'play_reporting'));
  if (svc?.encryptedSecret) return JSON.parse(decrypt(svc.encryptedSecret));
  if (env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64) {
    return JSON.parse(Buffer.from(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8'));
  }
  return null;
}

export function validateServiceAccountJson(raw: string): JWTInput {
  let parsed: JWTInput;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(422, 'invalid_json', 'Service account file is not valid JSON');
  }
  if (parsed.type !== 'service_account' || !parsed.client_email || !parsed.private_key) {
    throw new AppError(422, 'invalid_service_account', 'File is not a Google service-account key (type, client_email, private_key required)');
  }
  return parsed;
}

export async function savePlayServiceAccount(raw: string) {
  const parsed = validateServiceAccountJson(raw);
  await upsertService('play_reporting', {
    encryptedSecret: encrypt(JSON.stringify(parsed)),
    status: 'needs_setup',
    details: { clientEmail: parsed.client_email, projectId: parsed.project_id },
    lastError: null,
  });
  return { clientEmail: parsed.client_email };
}

export async function removePlayServiceAccount() {
  await upsertService('play_reporting', { encryptedSecret: null, status: 'not_configured', details: {}, lastError: null });
}

export async function getPlayAuth() {
  const credentials = await getPlayServiceAccount();
  if (!credentials) {
    throw new AppError(409, 'play_not_configured', 'Google Play service account is not configured');
  }
  return new GoogleAuth({ credentials, scopes: [PLAY_REPORTING_SCOPE] });
}
