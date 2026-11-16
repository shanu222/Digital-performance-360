# Google Cloud setup

Use one Google Cloud project for everything. Follow these steps in order.

## 1. Create the project and enable the APIs

Go to Google Cloud Console → **APIs & Services → Library** and enable each of these:

| API | Used for |
|---|---|
| Google Search Console API | Sites, Search Analytics, Sitemaps, URL Inspection |
| Google Analytics Data API | GA4 reports and realtime reports |
| Google Analytics Admin API | Discovering GA4 properties |
| AdMob API | Apps, ad units and the network report |
| Google Play Developer Reporting API | Android vitals |

## 2. OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen** and choose **External**. (If you use Google Workspace, **Internal** also works.)
2. Fill in an app name, for example *Digital Performance 360*, a support email, and your domain.
3. Add these **scopes**. They are all read-only:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/webmasters.readonly`
   - `.../auth/analytics.readonly`
   - `.../auth/admob.readonly`
   - `.../auth/admob.report`
4. Add your own Google account under **Test users**. While the app is in *Testing*, Google expires refresh tokens after **7 days**. Publish the app to stop that. Because these are sensitive scopes, Google may ask for verification. For a private, single-user tool you can stay in Testing and simply reconnect once a week.

## 3. OAuth client (redirect URI)

1. Go to **Credentials → Create credentials → OAuth client ID** and choose **Web application**.
2. **Authorized redirect URIs.** The callback is handled by the **backend**, not by Vercel. Add both:
   - `https://<your-railway-api-domain>/api/google/callback`
   - `http://localhost:8080/api/google/callback` (for local development)
3. **Authorized JavaScript origins** are not needed, because the browser never talks to Google APIs directly.
4. Copy the client ID and secret into the Railway API variables:

```
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxx
GOOGLE_REDIRECT_URI=https://<your-railway-api-domain>/api/google/callback
```

`GOOGLE_REDIRECT_URI` must match the URI in the console **character for character**.

## 4. Account access

- **Search Console.** The Google account you connect needs Owner or Full user access to each property. Properties where you are an *unverified user* show as "No access".
- **GA4.** The connected account needs at least the **Viewer** role. If a property does not show up during discovery, add it on the Integrations page by its numeric property ID.
- **AdMob.** The connected account must be a user on the AdMob account. Turn on **AdMob API access** in AdMob → Settings → Account information if your account shows that option.

## 5. Google Play Developer Reporting (service account)

Connecting with OAuth **does not** give access to Play Console data. You need a service account:

1. Go to Google Cloud → **IAM & Admin → Service accounts → Create**. It does not need any roles.
2. Open **Keys → Add key → JSON** and download the file.
3. In Play Console → **Users and permissions → Invite new users**, enter the service account's email address. Grant **View app information (read-only)** for all apps, or for the apps you choose.
4. In DP360 → **Integrations**, upload the JSON file. It is encrypted and stored. You can instead set the key on the Railway API and worker services:
   `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64=$(base64 -w0 key.json)`
5. Allow up to 24 hours for the new Play permission to take effect. Then click **Re-discover properties**.

What this API provides: crash rate, ANR rate, slow start, slow rendering, excessive wakeups, stuck background wakelocks, and error counts.
What it does **not** provide: installs, acquisition data or financial data. For those, export the CSV from Play Console → Statistics and import it on the app's page.

## 6. Quotas worth knowing

- **Search Analytics:** about 1,200 queries per minute for each site. The worker paginates at 25,000 rows per request and runs a limited number of properties at once.
- **URL Inspection:** about 2,000 inspections per day and 600 per minute for each property.
- **GA4 Data API:** token buckets per property. The worker uses at most 10 metrics per request and retries with backoff when it hits 429 errors.
- **AdMob:** the worker requests one network report per account per run.
