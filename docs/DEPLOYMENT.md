# Deployment: Vercel (frontend) and Railway (API, worker, PostgreSQL)

The frontend and backend run on different domains. Sessions use a cookie with `SameSite=None; Secure` and CORS with credentials, so **both sides must use HTTPS** in production. They always do on Vercel and Railway.

---

## 1. Local development

See the README quick start. You need two backend terminals (`npm run dev` and `npm run dev:worker`) and one frontend terminal. To run everything in one process, set `RUN_SCHEDULER_IN_API=true` in the backend `.env`.

## 2. PostgreSQL on Railway

1. Create a Railway project, then **New → Database → PostgreSQL**.
2. The worker and API reference it through `DATABASE_URL=${{Postgres.DATABASE_URL}}`. Use the *private* URL, which is the default when you reference it.
3. Backups: on the Railway Postgres service, open **Backups** and enable scheduled backups (Pro plan). Alternatively, schedule `pg_dump` from a separate cron service.

## 3. Backend API on Railway

1. **New → GitHub Repo**, pick this repository, then go to **Settings**:
   - **Root Directory:** `backend`
   - Railway reads `backend/railway.json`. It builds with `npm ci && npm run build`, starts with `npm run start`, and health-checks `/api/health`.
2. **Variables.** Add these under the service's **Variables** tab. You can use the RAW editor and paste the block:

```
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
FRONTEND_URL=https://<your-app>.vercel.app
BACKEND_URL=https://<api-service>.up.railway.app
ADMIN_EMAIL=you@yourdomain.com
ADMIN_PASSWORD=<long passphrase — change after first login>
ADMIN_NAME=Your Name
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://<api-service>.up.railway.app/api/google/callback
TOKEN_ENCRYPTION_KEY=<32 random bytes, base64>
SESSION_SECRET=<long random string>
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
EMAIL_PROVIDER=resend
EMAIL_PROVIDER_API_KEY=re_...
EMAIL_FROM=Digital Performance 360 <reports@yourdomain.com>
EMAIL_TO=you@yourdomain.com
APP_TIMEZONE=Asia/Karachi
DEFAULT_CURRENCY=USD
RUN_SCHEDULER_IN_API=false
```

3. Go to **Settings → Networking → Generate Domain**. Use this domain for `BACKEND_URL` and `GOOGLE_REDIRECT_URI`.
4. Migrations run automatically every time the API starts. Set `SKIP_MIGRATIONS=true` to turn that off.

> ⚠️ `TOKEN_ENCRYPTION_KEY` encrypts the stored Google tokens. If you change it, you must reconnect Google and upload the Play key again.

## 4. Sync worker on Railway

1. In the same project, **New → GitHub Repo** again with the same repository, and set **Root Directory** to `backend`.
2. Go to **Settings → Config-as-code → Railway config file** and set it to `backend/railway.worker.json`. That file sets the start command to `npm run start:worker`, the health check to `/health`, and the restart policy to always restart. Without this setting, the worker would read `railway.json`, which is the API's config.
3. **Variables.** Use the same values as the API. Railway's *Shared Variables* let you define them once. Leave out the `ADMIN_*` values. Keep `RUN_SCHEDULER_IN_API=false` on the API service.
4. The worker runs node-cron in your configured time zone. It writes jobs to the Postgres queue and processes them. It runs all the time, so data keeps arriving even when nobody is logged in. Schedules can be edited under **Settings** in the dashboard, and the worker reloads them within 5 minutes.

> Do not use Vercel functions or Railway cron containers for syncs. Long syncs (initial backfills) can take several minutes, and the worker service is designed for that.

**Single-service alternative.** Skip the worker service and set `RUN_SCHEDULER_IN_API=true` on the API. Do not do both, although duplicate job enqueues are prevented either way.

## 5. Frontend on Vercel

1. **Add New → Project** and import the repository.
2. **Root Directory:** `frontend`. Vercel detects Vite. `frontend/vercel.json` sets the SPA rewrites and security headers.
3. **Environment Variables:** add exactly one, for Production and Preview:

```
VITE_API_BASE_URL=https://<api-service>.up.railway.app
```

   Never put secrets in Vercel variables. Anything prefixed `VITE_` ends up in the browser bundle.
4. Deploy, then copy the production URL into the API's `FRONTEND_URL` and redeploy the API so CORS allows it.
5. **Preview deployments:** add their origins to `FRONTEND_URL`, separated by commas.

## 6. Custom domains

- **Frontend:** Vercel → Project → **Domains**, for example `dashboard.yourdomain.com`.
- **API:** Railway → API service → **Settings → Networking → Custom Domain**, for example `api.yourdomain.com`. Add the CNAME record Railway shows you.
- Then update:
  - `FRONTEND_URL` and `BACKEND_URL` (Railway)
  - `VITE_API_BASE_URL` (Vercel, then redeploy)
  - `GOOGLE_REDIRECT_URI` (Railway) **and** the redirect URI in the Google OAuth client
- Tip: if both apps sit under the same registrable domain (`dashboard.` and `api.yourdomain.com`), browsers treat the session cookie as first-party. That avoids third-party-cookie restrictions in Safari and some other browsers. **This setup is recommended for production.**

## 7. Production testing

Work through `docs/TESTING.md` → *Production checklist* after the first deployment.
