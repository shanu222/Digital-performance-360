import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';
import { allowedOrigins, isProd } from './config/env.js';
import { AppError } from './lib/http.js';
import { errorMessage, logger } from './lib/logger.js';
import { health, auth, google, integrations, settings, sync, notificationsRouter } from './routes/core.js';
import { overview, websitesRouter, seo, keywords, pages, indexing, sitemaps, analytics } from './routes/data.js';
import { androidAppsRouter, playConsole, appHealth, admob, ai, reports } from './routes/apps.js';
import { apiDocs } from './routes/docs.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Railway / Vercel sit behind a proxy
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(
    cors({
      origin(origin, cb) {
        // non-browser requests (health checks, OAuth redirects) have no Origin
        if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) return cb(null, true);
        cb(new AppError(403, 'cors', `Origin ${origin} is not allowed`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
      exposedHeaders: ['Content-Disposition'],
      maxAge: 600,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '6mb' }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/api/health' },
      serializers: { req: (req) => ({ method: req.method, url: req.url?.split('?')[0] }), res: (res) => ({ statusCode: res.statusCode }) },
    }),
  );
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

  app.use('/api/health', health);
  app.use('/api/docs', apiDocs);
  app.use('/api/auth', auth);
  app.use('/api/google', google);
  app.use('/api/integrations', integrations);
  app.use('/api/settings', settings);
  app.use('/api/sync', sync);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/overview', overview);
  app.use('/api/websites', websitesRouter);
  app.use('/api/seo', seo);
  app.use('/api/search-console', seo);
  app.use('/api/keywords', keywords);
  app.use('/api/pages', pages);
  app.use('/api/indexing', indexing);
  app.use('/api/sitemaps', sitemaps);
  app.use('/api/analytics', analytics);
  app.use('/api/android-apps', androidAppsRouter);
  app.use('/api/play-console', playConsole);
  app.use('/api/app-health', appHealth);
  app.use('/api/admob', admob);
  app.use('/api/revenue', admob);
  app.use('/api/ai', ai);
  app.use('/api/reports', reports);

  app.use('/api', (_req, _res, next) => next(new AppError(404, 'not_found', 'Endpoint not found')));

  // Centralised error handler: consistent envelope, no stack traces or secrets in responses
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return res.status(422).json({ ok: false, error: { code: 'validation_error', message: 'Invalid request' } });
    }
    const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return res.status(status).json({ ok: false, error: { code: 'bad_request', message: errorMessage(err) } });
    }
    // Google API errors surface as upstream failures with a scrubbed message
    const gStatus = (err as { response?: { status?: number } }).response?.status;
    if (gStatus) {
      req.log?.warn({ err: errorMessage(err), gStatus }, 'Upstream Google API error');
      return res.status(502).json({ ok: false, error: { code: 'upstream_error', message: errorMessage(err) } });
    }
    req.log?.error({ err: errorMessage(err) }, 'Unhandled error');
    res.status(500).json({ ok: false, error: { code: 'internal_error', message: isProd ? 'Something went wrong' : errorMessage(err) } });
  });

  return app;
}
