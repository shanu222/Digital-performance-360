import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Globe, Search, BarChart3, DollarSign, Smartphone, ShieldCheck } from 'lucide-react';
import { api, post } from '../lib/api';
import { useToast, errMsg } from '../lib/context';
import { Button, Card, Notice, PageHeader, StatusBadge, Toggle, Skeleton, Empty } from '../components/ui';
import { useAction } from '../lib/hooks';
import { fmtAgo } from '../lib/format';

interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  status: string | null;
  grantedScopes: string[];
}
interface Props {
  searchConsole: Array<{ id: string; siteUrl: string; propertyType: string; permissionLevel: string | null; isSelected: boolean; isAccessible: boolean; syncStatus: string; lastSyncedAt: string | null }>;
  ga4: Array<{ id: string; displayName: string; propertyName: string; accountDisplayName: string | null; isSelected: boolean; syncStatus: string; lastSyncedAt: string | null }>;
  admobAccounts: Array<{ id: string; publisherId: string; currencyCode: string | null; isSelected: boolean; syncStatus: string; lastSyncedAt: string | null }>;
  admobApps: Array<{ id: string; displayName: string | null; appId: string; platform: string | null; storeId: string | null }>;
  playApps: Array<{ id: string; displayName: string | null; packageName: string; isSelected: boolean; syncStatus: string }>;
}

export async function connectGoogle() {
  const { url } = await post<{ url: string }>('/api/google/connect');
  window.location.assign(url);
}

export function PropertySelector() {
  const props = useQuery({ queryKey: ['properties'], queryFn: () => api<Props>('/api/integrations/properties'), refetchInterval: 15_000 });
  const toggle = useAction(({ kind, id, isSelected }: { kind: string; id: string; isSelected: boolean }) => api(`/api/integrations/${kind}/${id}`, { method: 'PATCH', json: { isSelected } }), {
    success: 'Selection saved — synchronization queued where enabled',
    invalidate: [['properties'], ['websites'], ['website-list']],
  });
  if (props.isLoading) return <Skeleton className="h-60" />;
  const d = props.data;
  if (!d) return null;
  const row = (key: string, title: string, sub: string, selected: boolean, kind: string, id: string, status: string, last: string | null, disabled = false) => (
    <li key={key} className="flex items-center gap-3 py-2.5">
      <Toggle checked={selected} onChange={(v) => toggle.mutate({ kind, id, isSelected: v })} label={`Monitor ${title}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{title}</div>
        <div className="truncate text-xs text-muted">{sub}</div>
      </div>
      {disabled ? <StatusBadge status="error" label="No access" /> : selected ? <StatusBadge status={status === 'never' ? 'never_synced' : status} /> : null}
      {selected && <span className="hidden w-20 text-right text-[11px] text-muted sm:block">{fmtAgo(last)}</span>}
    </li>
  );
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card title="Search Console properties" subtitle={`${d.searchConsole.length} discovered · domain and URL-prefix`} source="Sites API">
        {d.searchConsole.length ? (
          <ul className="divide-y divide-line">{d.searchConsole.map((p) => row(p.id, p.siteUrl, `${p.propertyType === 'domain' ? 'Domain property' : 'URL-prefix property'} · ${p.permissionLevel ?? 'unknown permission'}`, p.isSelected, 'search-console', p.id, p.syncStatus, p.lastSyncedAt, !p.isAccessible))}</ul>
        ) : (
          <Empty title="No properties found yet">Discovery runs right after connecting. The connected account must have access in Search Console.</Empty>
        )}
      </Card>
      <Card title="Google Analytics 4 properties" subtitle={`${d.ga4.length} discovered`} source="Admin API">
        {d.ga4.length ? (
          <ul className="divide-y divide-line">{d.ga4.map((p) => row(p.id, p.displayName, `${p.propertyName} · ${p.accountDisplayName ?? ''}`, p.isSelected, 'ga4', p.id, p.syncStatus, p.lastSyncedAt))}</ul>
        ) : (
          <Empty title="No GA4 properties found">You can add one manually on the Integrations page.</Empty>
        )}
      </Card>
      <Card title="AdMob accounts" subtitle={`${d.admobAccounts.length} account(s) · ${d.admobApps.length} apps`} source="AdMob API">
        {d.admobAccounts.length ? (
          <ul className="divide-y divide-line">{d.admobAccounts.map((a) => row(a.id, a.publisherId, `Reporting currency ${a.currencyCode ?? '—'}`, a.isSelected, 'admob', a.id, a.syncStatus, a.lastSyncedAt))}</ul>
        ) : (
          <Empty title="No AdMob account found">The connected Google account must be a user on the AdMob account.</Empty>
        )}
      </Card>
      <Card title="Google Play apps" subtitle="Requires the Play service account (see Integrations)" source="Play Reporting API">
        {d.playApps.length ? (
          <ul className="divide-y divide-line">{d.playApps.map((a) => row(a.id, a.displayName ?? a.packageName, a.packageName, a.isSelected, 'play', a.id, a.syncStatus, null))}</ul>
        ) : (
          <Empty title="No Play apps yet">
            Add the service account under <Link className="text-accent underline" to="/integrations">Integrations</Link> and grant it access in Play Console.
          </Empty>
        )}
      </Card>
    </div>
  );
}

export default function Onboarding() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['google-status'], queryFn: () => api<GoogleStatus>('/api/google/status') });

  useEffect(() => {
    const g = params.get('google');
    if (!g) return;
    if (g === 'connected') toast('success', 'Google account connected. Discovering your properties…');
    else toast('error', `Google connection failed (${params.get('reason') ?? 'unknown'}). Please try again.`);
    qc.invalidateQueries();
    setParams({}, { replace: true });
  }, [params, setParams, toast, qc]);

  const s = status.data;
  return (
    <div>
      <PageHeader eyebrow="Setup" title="Connect your Google account" subtitle="One secure, read-only connection discovers every Search Console, Analytics and AdMob property you can access." />
      <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          {status.isLoading ? (
            <Skeleton className="h-40" />
          ) : s?.connected ? (
            <div className="flex items-start gap-4">
              <div className="rounded-xl bg-good-soft p-3 text-good">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div className="flex-1">
                <div className="text-lg font-bold">Connected as {s.email}</div>
                <div className="mt-1 text-sm text-ink-2">Choose below which properties to monitor. Selected properties are synchronized automatically every day, even when you are not logged in.</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusBadge status={s.status ?? 'connected'} />
                  <Button size="sm" onClick={() => post('/api/integrations/discover').then(() => toast('info', 'Discovery queued')).catch((e) => toast('error', errMsg(e)))}>
                    Re-discover properties
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <div className="text-lg font-bold">Connect Google Account</div>
              <p className="mt-1 text-sm text-ink-2">You will be redirected to Google’s official consent page. Only read-only permissions are requested.</p>
              {!s?.configured && (
                <div className="mt-4">
                  <Notice tone="warn">The backend has no Google OAuth client configured yet. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI on Railway (see docs/GOOGLE_SETUP.md).</Notice>
                </div>
              )}
              <Button variant="primary" className="mt-5" disabled={!s?.configured} onClick={() => connectGoogle().catch((e) => toast('error', errMsg(e)))} icon={<ExternalLink className="h-4 w-4" />}>
                Connect Google Account
              </Button>
            </div>
          )}
        </Card>
        <Card title="Permissions requested" subtitle="Minimum read-only scopes — no Gmail, Drive or write access">
          <ul className="space-y-3 text-sm">
            {[
              [Search, 'Search Console', 'webmasters.readonly'],
              [BarChart3, 'Google Analytics 4', 'analytics.readonly'],
              [DollarSign, 'AdMob', 'admob.readonly · admob.report'],
              [Smartphone, 'Google Play vitals', 'separate service account (guided setup)'],
              [ShieldCheck, 'Your identity', 'openid · email'],
            ].map(([Icon, name, scope]) => {
              const I = Icon as typeof Globe;
              return (
                <li key={name as string} className="flex items-center gap-3">
                  <I className="h-4 w-4 text-cyan" />
                  <span className="font-semibold">{name as string}</span>
                  <span className="ml-auto font-mono text-[11px] text-muted">{scope as string}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
      {s?.connected && (
        <div className="mt-6">
          <PropertySelector />
          <div className="mt-6 flex justify-end">
            <Link to="/">
              <Button variant="gold">Go to dashboard</Button>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
