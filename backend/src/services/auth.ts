import bcrypt from 'bcryptjs';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, userSessions } from '../db/schema.js';
import { hashToken, randomToken } from '../lib/crypto.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const SESSION_COOKIE = 'dp360_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 12);
}

export async function verifyPassword(pw: string, hash: string) {
  return bcrypt.compare(pw, hash);
}

/** Seed the private administrator from env on first boot (idempotent). */
export async function ensureAdminUser() {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length) return;
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    logger.warn('No users exist and ADMIN_EMAIL / ADMIN_PASSWORD are not set — login will be impossible until they are.');
    return;
  }
  await db.insert(users).values({
    email: env.ADMIN_EMAIL.toLowerCase(),
    name: env.ADMIN_NAME,
    passwordHash: await hashPassword(env.ADMIN_PASSWORD),
    role: 'admin',
  });
  logger.info('Administrator account created from environment');
}

export async function createSession(userId: string, meta: { ip?: string; userAgent?: string }) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(userSessions).values({
    id: hashToken(token),
    userId,
    csrfToken,
    ip: meta.ip?.slice(0, 64),
    userAgent: meta.userAgent?.slice(0, 256),
    expiresAt,
  });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  return { token, csrfToken, expiresAt };
}

export async function getSession(token: string) {
  const [row] = await db
    .select({
      sessionId: userSessions.id,
      csrfToken: userSessions.csrfToken,
      expiresAt: userSessions.expiresAt,
      user: { id: users.id, email: users.email, name: users.name, role: users.role, isActive: users.isActive },
    })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(and(eq(userSessions.id, hashToken(token)), gt(userSessions.expiresAt, new Date())));
  if (!row || !row.user.isActive) return null;
  return row;
}

export async function destroySession(token: string) {
  await db.delete(userSessions).where(eq(userSessions.id, hashToken(token)));
}

export async function purgeExpiredSessions() {
  await db.delete(userSessions).where(lt(userSessions.expiresAt, new Date()));
}
