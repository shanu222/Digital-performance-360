import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshDb } from './db.js';
import { gres } from './helpers.js';
import { db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { encrypt } from '../src/lib/crypto.js';
import { ensureAdminUser } from '../src/services/auth.js';
import { discoverSearchConsoleProperties } from '../src/services/google/searchConsole.js';
import { disconnectGoogle, markGoogleRevoked, activeGoogleAccounts, getAuthedClient } from '../src/services/google/oauth.js';

async function addAccount(sub: string, email: string) {
  const [u] = await db.select().from(s.users);
  const [a] = await db.insert(s.googleAccounts).values({ userId: u.id, googleSub: sub, email }).returning();
  await db.insert(s.oauthCredentials).values({ googleAccountId: a.id, encryptedRefreshToken: encrypt(`refresh-${sub}`) });
  return a;
}
const sites = (...list: Array<[string, string]>) => ({ sites: { list: () => gres({ siteEntry: list.map(([siteUrl, permissionLevel]) => ({ siteUrl, permissionLevel })) }) } });

beforeEach(async () => {
  await freshDb();
  await ensureAdminUser();
});

describe('multiple Google accounts', () => {
  it('discovers properties from every account and remembers which account reads each', async () => {
    const a = await addAccount('sub-a', 'a@gmail.com');
    const b = await addAccount('sub-b', 'b@gmail.com');
    await discoverSearchConsoleProperties(sites(['sc-domain:one.com', 'siteOwner'], ['sc-domain:shared.com', 'siteOwner']) as never, a.id);
    await discoverSearchConsoleProperties(sites(['sc-domain:two.com', 'siteOwner'], ['sc-domain:shared.com', 'siteFullUser'], ['sc-domain:one.com', 'siteUnverifiedUser']) as never, b.id);
    const props = await db.select().from(s.searchConsoleProperties);
    const by = Object.fromEntries(props.map((p) => [p.siteUrl, p]));
    expect(props).toHaveLength(3);
    expect(by['sc-domain:one.com'].googleAccountId).toBe(a.id);
    expect(by['sc-domain:one.com'].isAccessible).toBe(true); // B's unverified access doesn't downgrade A's
    expect(by['sc-domain:two.com'].googleAccountId).toBe(b.id);
    expect(by['sc-domain:shared.com'].googleAccountId).toBe(a.id); // first working account keeps it
  });

  it('only marks properties of the same account as inaccessible when they disappear', async () => {
    const a = await addAccount('sub-a', 'a@gmail.com');
    const b = await addAccount('sub-b', 'b@gmail.com');
    await discoverSearchConsoleProperties(sites(['sc-domain:one.com', 'siteOwner']) as never, a.id);
    await discoverSearchConsoleProperties(sites(['sc-domain:two.com', 'siteOwner']) as never, b.id);
    await discoverSearchConsoleProperties(sites() as never, a.id); // A lost access to everything
    const [one] = await db.select().from(s.searchConsoleProperties).where(eq(s.searchConsoleProperties.siteUrl, 'sc-domain:one.com'));
    const [two] = await db.select().from(s.searchConsoleProperties).where(eq(s.searchConsoleProperties.siteUrl, 'sc-domain:two.com'));
    expect(one.isAccessible).toBe(false);
    expect(two.isAccessible).toBe(true);
  });

  it('hands a shared property to another account when its account is revoked', async () => {
    const a = await addAccount('sub-a', 'a@gmail.com');
    const b = await addAccount('sub-b', 'b@gmail.com');
    await discoverSearchConsoleProperties(sites(['sc-domain:shared.com', 'siteOwner']) as never, a.id);
    await markGoogleRevoked('invalid_grant', a.id);
    expect((await activeGoogleAccounts()).map((x) => x.google_accounts.email)).toEqual(['b@gmail.com']);
    await expect(getAuthedClient(a.id)).rejects.toMatchObject({ code: 'google_revoked' });
    await discoverSearchConsoleProperties(sites(['sc-domain:shared.com', 'siteOwner']) as never, b.id);
    const [p] = await db.select().from(s.searchConsoleProperties);
    expect(p.googleAccountId).toBe(b.id);
  });

  it('disconnecting one account keeps the others', async () => {
    const a = await addAccount('sub-a', 'a@gmail.com');
    const b = await addAccount('sub-b', 'b@gmail.com');
    await discoverSearchConsoleProperties(sites(['sc-domain:one.com', 'siteOwner']) as never, a.id);
    await discoverSearchConsoleProperties(sites(['sc-domain:two.com', 'siteOwner']) as never, b.id);
    await disconnectGoogle(a.id);
    const accounts = await db.select().from(s.googleAccounts);
    expect(accounts.map((x) => x.email)).toEqual(['b@gmail.com']);
    const props = await db.select().from(s.searchConsoleProperties);
    expect(props.find((p) => p.siteUrl === 'sc-domain:one.com')!.isAccessible).toBe(false);
    expect(props.find((p) => p.siteUrl === 'sc-domain:two.com')!.isAccessible).toBe(true);
    void b;
  });
});
