import { db } from '../src/db/client.js';
import { googleAccounts, oauthCredentials, users } from '../src/db/schema.js';
import { encrypt } from '../src/lib/crypto.js';
import { ensureAdminUser } from '../src/services/auth.js';

/** Seeds the admin and a connected Google account with encrypted (fake) tokens. */
export async function seedGoogle() {
  await ensureAdminUser();
  const [u] = await db.select().from(users);
  const [acct] = await db
    .insert(googleAccounts)
    .values({ userId: u.id, googleSub: 'sub-1', email: 'owner@example.com', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'] })
    .returning();
  await db.insert(oauthCredentials).values({
    googleAccountId: acct.id,
    encryptedRefreshToken: encrypt('fake-refresh'),
    encryptedAccessToken: encrypt('fake-access'),
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
  });
  return { user: u, account: acct };
}

export const gres = <T>(data: T) => Promise.resolve({ data });
