# Environment variables & service settings

> Real secret values are never committed. Paste them directly into Railway and Vercel.

## Railway: project layout

| Service | Source | Root Directory | Config file |
|---|---|---|---|
| **Postgres** | New → Database → PostgreSQL | — | — |
| **dp360-api** | GitHub `shanu222/Digital-performance-360` | `backend` | `backend/railway.json` (default) |
| **dp360-worker** | same repo | `backend` | `backend/railway.worker.json` (Settings → Config-as-code) |

API service settings:
- Networking → Generate Domain (target port = `PORT`, Railway sets it)
- Healthcheck path `/api/health` (comes from railway.json)

Worker service settings:
- Config file `backend/railway.worker.json`. It sets the start command `npm run start:worker` and the health check `/health`.
- A public domain is not needed.

## Railway: dp360-api variables

```
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
FRONTEND_URL=https://<your-vercel-domain>
BACKEND_URL=https://<api-railway-domain>
ADMIN_EMAIL=<admin email>
ADMIN_PASSWORD=<admin password>
ADMIN_NAME=<your name>
GOOGLE_CLIENT_ID=<from Google Cloud OAuth client>
GOOGLE_CLIENT_SECRET=<from Google Cloud OAuth client>
GOOGLE_REDIRECT_URI=https://<api-railway-domain>/api/google/callback
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64=
TOKEN_ENCRYPTION_KEY=<32 random bytes base64 — never change after first use>
SESSION_SECRET=<long random string>
OPENAI_API_KEY=<sk-...>
OPENAI_MODEL=gpt-4o-mini
EMAIL_PROVIDER=resend
EMAIL_PROVIDER_API_KEY=<re_...>
EMAIL_FROM=Digital Performance 360 <reports@<verified-domain>>
EMAIL_TO=<recipient>
APP_TIMEZONE=Asia/Karachi
DEFAULT_CURRENCY=USD
RUN_SCHEDULER_IN_API=false
LOG_LEVEL=info
```

`ADMIN_EMAIL` and `ADMIN_PASSWORD` only create the administrator when the users table is **empty**, which is the first boot. Later changes go through Settings → Account & security.

## Railway: dp360-worker variables

Use the same values as the API. You can leave out `ADMIN_*` and `FRONTEND_URL`. The worker **must** share `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, the `GOOGLE_*` values, `OPENAI_*`, the `EMAIL_*` values and `APP_TIMEZONE` with the API.

## Vercel

| Setting | Value |
|---|---|
| Framework preset | Vite |
| Root Directory | `frontend` |
| Build command | `npm run build` (default) |
| Output directory | `dist` |
| Node.js version | 20.x or 22.x |

Environment variables (Production + Preview):

```
VITE_API_BASE_URL=https://<api-railway-domain>
```

After the first deploy, copy the Vercel URL into `FRONTEND_URL` on Railway and redeploy the API.

## Resend (email)

1. resend.com → **Domains → Add domain**, for example `sustainablesolution360.com` (or a subdomain such as `mail.`). Add the DNS records it shows (SPF, DKIM, and optionally DMARC) at your DNS host, then wait until the domain shows **Verified**.
2. **API Keys → Create**: permission *Sending access*, restricted to that domain. Copy the key into `EMAIL_PROVIDER_API_KEY`.
3. `EMAIL_FROM` must use the verified domain, for example `Digital Performance 360 <reports@sustainablesolution360.com>`.
4. In the dashboard, go to Settings → Email reports → enable → **Send test email**.

## Google Cloud

See [GOOGLE_SETUP.md](./GOOGLE_SETUP.md). The redirect URI in the OAuth client must equal `GOOGLE_REDIRECT_URI` exactly.

## OpenAI

platform.openai.com → API keys → create a key → paste it into `OPENAI_API_KEY` on **both** Railway services. Set a monthly usage limit in Billing.
