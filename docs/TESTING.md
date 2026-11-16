# Testing

## Automated tests (backend)

```bash
cd backend && npm test
```

The tests run against a **real PostgreSQL engine in memory** (PGlite) using the real migrations. Google APIs are **mocked in the tests only**. Production code paths never use mock data.

| Suite | Covers |
|---|---|
| `unit.test.ts` | Token encryption (AES-GCM, tamper detection), date ranges and comparisons, time zones, sync windows, CSV formula-injection escaping, token scrubbing, AdMob stream parsing, health classification |
| `api.test.ts` | Health endpoint, 401 on every protected route, login with an http-only cookie, CSRF and Origin enforcement, validation (422), empty states return `null` (never 0), OAuth consent URL (read-only scopes, state, PKCE), forged-state rejection, logout |
| `integrations.test.ts` | OAuth code exchange with encrypted storage and single-use state; token refresh persistence; Search Console discovery, sync, **idempotent upserts**, preliminary-data labelling, keyword comparisons and signals; **error isolation** (one failing property → `partial`); GA4 sync with the `keyEvents`→`conversions` fallback; AdMob micros, eCPM, match rate and currency handling; Play vitals with partial availability; job-queue deduplication, atomic claim, backoff and stale recovery; alert creation plus **deduplication**; PDF, Excel and CSV generation, including empty states; daily report |

Frontend type safety: `cd frontend && npm run typecheck && npm run build`.

## Manual configuration checklist

- [ ] Google Cloud project created; all 5 APIs enabled (docs/GOOGLE_SETUP.md §1)
- [ ] OAuth consent screen set up with only the read-only scopes; your account added as a test user, or the app published
- [ ] OAuth web client created; redirect URI = `<API>/api/google/callback`
- [ ] Railway Postgres, API and worker services created; variables set (docs/DEPLOYMENT.md)
- [ ] Vercel project with `VITE_API_BASE_URL`; `FRONTEND_URL` on Railway updated to the Vercel URL
- [ ] Play service account created, invited in Play Console, and JSON uploaded on Integrations
- [ ] AdMob API access enabled for the AdMob account
- [ ] OpenAI key set (optional; AI pages show a setup notice without it)
- [ ] Email provider (Resend or SMTP) configured and verified sender domain (optional)

## Production checklist (run after deploying)

1. `GET https://<api>/api/health` returns `{"ok":true,"db":"up"}`. The worker's `/health` also returns ok.
2. Open the Vercel URL. You are redirected to `/login`. Sign in with `ADMIN_EMAIL`, then **change the password** under Settings.
3. Overview shows the "Connect Google" banner and no numbers. This confirms the dashboard has no hard-coded data.
4. Click **Connect Google Account**. Google's consent page lists only read-only permissions. You come back to `/onboarding?google=connected`.
5. The property lists fill in within a minute. Select a few Search Console and GA4 properties and an AdMob account. Jobs appear under **Integrations → Synchronization history**.
6. When the jobs finish:
   - **Websites** shows clicks and users.
   - **Keywords** and **Page Performance** list rows. CSV export downloads.
   - **SEO Analytics** labels preliminary days.
7. **Indexing Monitor:** inspect one URL. Coverage and canonical fields appear, and the result is saved in the history.
8. **AdMob:** period cards and tables show the correct currency, marked as estimated. Turning on PKR conversion shows the rate source and timestamp.
9. Upload the Play service account. **Google Play Health** lists your apps after the Play sync, with a status for each.
10. **AI Intelligence:** *Run analysis now* creates recommendations that cite metrics. Chat answers state the date range and sources.
11. **Reports:** generate PDF, Excel and CSV versions of the portfolio report and check that they open. Generate the daily report, then use *View*.
12. **Settings → Send test email.** Turn on daily email. The next morning, the scheduled daily report arrives.
13. Revoke the app at myaccount.google.com/permissions and trigger a sync. A critical *Google authorization problem* notification appears, and Integrations shows *Access revoked*. Reconnect to recover.
14. Sign out, then try `GET /api/overview` with no cookie. It returns 401.
