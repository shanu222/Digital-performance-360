import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/http.js';
import { getSession, SESSION_COOKIE } from '../services/auth.js';
import { safeEqual } from '../lib/crypto.js';
import { allowedOrigins } from '../config/env.js';

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthedUser;
    csrfToken?: string;
  }
}

/** Requires a valid session cookie. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new AppError(401, 'unauthenticated', 'Please sign in');
    const session = await getSession(token);
    if (!session) throw new AppError(401, 'unauthenticated', 'Session expired, please sign in again');
    req.user = { id: session.user.id, email: session.user.email, name: session.user.name, role: session.user.role };
    req.csrfToken = session.csrfToken;
    next();
  } catch (e) {
    next(e);
  }
}

/** Role gate — today only 'admin' exists; ready for editor/viewer later. */
export const requireRole =
  (...roles: string[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return next(new AppError(403, 'forbidden', 'Insufficient permissions'));
    next();
  };

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for a cross-site SPA (Vercel → Railway):
 *  1. Origin header must be on the allowlist for state-changing requests.
 *  2. X-CSRF-Token header must equal the token bound to the server-side session
 *     (issued by GET /api/auth/me — readable only by allowed origins via CORS).
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (SAFE.has(req.method)) return next();
  const origin = (req.headers.origin ?? '').replace(/\/$/, '');
  if (origin && !allowedOrigins.includes(origin)) return next(new AppError(403, 'bad_origin', 'Origin not allowed'));
  const header = String(req.headers['x-csrf-token'] ?? '');
  if (!req.csrfToken || !header || !safeEqual(header, req.csrfToken)) {
    return next(new AppError(403, 'csrf_failed', 'Invalid or missing CSRF token'));
  }
  next();
}
