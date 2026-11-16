# Digital Performance 360

**Monitor. Analyze. Optimize. Grow.**

A private control room for all of your websites, Android apps and ad revenue. It connects one Google account and finds every Search Console property, GA4 property and AdMob account that account can reach. Android vitals come from Google Play through a separate service account. A background worker on Railway pulls the data every day and keeps it in PostgreSQL, and the dashboard on Vercel shows it as portfolio views and one dashboard per site or app. The platform also produces AI recommendations, alerts, daily emails and PDF, Excel and CSV reports.

Nothing in the dashboard is sample data. When a service is not connected, the dashboard shows an empty state. When Google does not provide a value, it shows "—" instead of 0.

```
┌──────────────────────┐   HTTPS + http-only cookie + CSRF header   ┌───────────────────────────┐
│  frontend/  (Vercel) │ ─────────────────────────────────────────▶ │  backend/ API  (Railway)   │
│  React · Vite · TS   │                                            │  Express · TS · Drizzle    │
│  Tailwind · Recharts │                                            ├───────────────────────────┤
└──────────────────────┘                                            │  backend/ worker (Railway) │
                                                                    │  node-cron + Postgres queue│
                                                                    └──────────────┬────────────┘
                                         Google APIs (server-side only) ◀──────────┤
                                         Search Console · GA4 Data/Admin           │
                                         AdMob · Play Developer Reporting          ▼
                                         OpenAI (backend only)            PostgreSQL (Railway)
```

## Repository layout

| Path | What it is |
|---|---|
| `backend/src/index.ts` | REST API entrypoint (runs migrations, seeds the admin, serves `/api/*`) |
| `backend/src/worker.ts` | Scheduler and job worker. Deploy it as a second Railway service |
| `backend/src/db/schema.ts` | The full PostgreSQL schema (Drizzle). Migrations are in `backend/drizzle/` |
| `backend/src/services/google/` | Search Console, GA4, AdMob, Play Reporting and OAuth integrations |
| `backend/src/services/sync/` | Postgres-backed job queue (`SKIP LOCKED`), handlers, cron runner |
| `backend/src/services/metrics.ts` | Every aggregation the dashboard and reports use |
| `backend/src/services/ai.ts` | Evidence packs, daily recommendations, and the chat assistant that uses DB tools |
| `backend/src/services/reports/` | Report builder plus the PDF (pdfkit), Excel (exceljs) and CSV renderers, and the daily email |
| `backend/test/` | Vitest suites. They use mocked Google responses and an in-memory PostgreSQL (PGlite) |
| `frontend/src/pages/` | All dashboard pages |
| `docs/` | Deployment, Google setup and testing checklists |

## Quick start (local)

Requirements: Node 20+ and PostgreSQL 14+.

```bash
# 1. Database
createdb dp360

# 2. Backend
cd backend
cp .env.example .env            # fill DATABASE_URL, ADMIN_*, TOKEN_ENCRYPTION_KEY, SESSION_SECRET, GOOGLE_*
npm install
npm run db:migrate:dev
npm run dev                     # API on :8080
npm run dev:worker              # in another terminal: scheduler + sync worker

# 3. Frontend
cd ../frontend
cp .env.example .env            # VITE_API_BASE_URL=http://localhost:8080
npm install
npm run dev                     # http://localhost:5173
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Then open **Connect Google Account**, choose the properties you want to monitor, and the first sync starts on its own.

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # TOKEN_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" # SESSION_SECRET
```

## Data accuracy rules built into the code

- **Search Console.** The worker queries with `dataState=all`. Days at or after Google's `firstIncompleteDate` are stored as `fresh` (preliminary) and labelled that way in the UI. They are fetched again on every run until they become final. Average position is impression-weighted. Keyword "rankings" are period averages, not exact daily ranks.
- **URL Inspection** checks one URL at a time. It is never presented as a complete index of the site.
- **GA4.** Users cannot be added across days, so stored range totals are labelled "sum of daily". For a single property, a live, deduplicated GA4 query supplies the real range total. If the API rejects `keyEvents`, the worker falls back to `conversions`. Revenue is only shown when it is configured.
- **AdMob.** Earnings are stored in micros, in the account's original reporting currency, and labelled *estimated*. Earnings in different currencies are never added together. Optional USD/PKR conversion is shown alongside, with the rate source (open.er-api.com), the rate date and the fetch time.
  - eCPM = earnings ÷ impressions × 1000
  - Match rate = matched ÷ requests × 100
  - Show rate = impressions ÷ matched × 100
- **Play vitals.** Metric names come from the official v1beta1 reference. The API returns fractions, which are stored as percentages. Daily data uses the `America/Los_Angeles` time zone, as the API requires, and the worker respects the API's freshness info. If one metric set is unavailable, the others still sync. Install and acquisition numbers are **not** offered by this API, so they come from a labelled CSV import.
- **AI** receives only evidence packs computed from the database. It is told not to invent numbers or promise outcomes, and each recommendation lists the metrics it is based on.

## Security

- Google OAuth uses a single-use `state` and PKCE (S256), and requests only read-only scopes. Refresh and access tokens are encrypted with AES-256-GCM in a table separate from the analytics data. Tokens never reach the frontend or the logs, which have redaction and scrubbing.
- Admin sessions use an http-only cookie that is `Secure; SameSite=None` in production. Session IDs are stored as HMAC hashes. Every write must carry an `X-CSRF-Token` header bound to the session, and its Origin must be on the allowlist.
- Other protections: bcrypt (cost 12), login rate limiting, a global API rate limit, Helmet, a CORS allowlist, zod validation on every input, parameterised SQL through Drizzle, and an error handler that keeps internals out of responses. CSV exports are protected against formula injection.
- `users.role` is already in place, and routes use `requireRole`, so team accounts can be added later without changing the schema.

See **docs/DEPLOYMENT.md**, **docs/GOOGLE_SETUP.md** and **docs/TESTING.md**.
