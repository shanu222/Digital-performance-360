import { ExternalLink, Plus, Unplug, RefreshCw, Search, BarChart3, DollarSign } from 'lucide-react';
import { post } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useToast, errMsg } from '../lib/context';
import { fmtDate } from '../lib/format';
import { Button, Card, Notice, StatusBadge } from './ui';

export interface GoogleAccount {
  id: string;
  email: string | null;
  status: string;
  grantedScopes: string[];
  connectedAt: string;
  lastError: string | null;
  properties: { searchConsole: number; ga4: number; admob: number };
}

export async function connectGoogle() {
  const { url } = await post<{ url: string }>('/api/google/connect');
  window.location.assign(url);
}

/** Every connected Google account, with add / reconnect / disconnect per account. */
export function GoogleAccountsCard({ accounts, configured }: { accounts: GoogleAccount[]; configured: boolean }) {
  const toast = useToast();
  const inv = [['integrations'], ['properties'], ['google-status'], ['jobs'], ['sync-status']];
  const disconnect = useAction((id: string) => post('/api/google/disconnect', { accountId: id }), { success: 'Account disconnected and its tokens revoked', invalidate: inv });
  const discover = useAction(() => post('/api/integrations/discover'), { success: 'Discovery queued for all accounts', invalidate: inv });
  const connect = () => connectGoogle().catch((e) => toast('error', errMsg(e)));

  return (
    <Card
      title="Google accounts"
      subtitle="Connect every Google account that owns Search Console, GA4 or AdMob properties. Each property is read with the account that has access to it."
      actions={
        <>
          {accounts.length > 0 && (
            <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={discover.isPending} onClick={() => discover.mutate(undefined)}>
              Re-discover
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!configured} icon={<Plus className="h-3.5 w-3.5" />} onClick={connect}>
            {accounts.length ? 'Add another Google account' : 'Connect Google account'}
          </Button>
        </>
      }
    >
      {!configured && <Notice tone="warn">The backend OAuth client is not configured (GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI on Railway).</Notice>}
      {accounts.length === 0 ? (
        <p className="text-sm text-ink-2">No Google account connected yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {accounts.map((a) => (
            <li key={a.id} className="flex flex-col gap-3 py-3 md:flex-row md:items-center">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold-soft text-sm font-extrabold text-gold">{(a.email ?? '?').slice(0, 1).toUpperCase()}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-semibold">{a.email ?? 'Unknown account'}</span>
                  <StatusBadge status={a.status === 'active' ? 'connected' : a.status} />
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
                  <span className="inline-flex items-center gap-1"><Search className="h-3 w-3 text-cyan" />{a.properties.searchConsole} Search Console</span>
                  <span className="inline-flex items-center gap-1"><BarChart3 className="h-3 w-3 text-cyan" />{a.properties.ga4} GA4</span>
                  <span className="inline-flex items-center gap-1"><DollarSign className="h-3 w-3 text-cyan" />{a.properties.admob} AdMob</span>
                  <span className="text-muted">connected {fmtDate(a.connectedAt)}</span>
                </div>
                {a.lastError && a.status !== 'active' && <div className="mt-1 text-xs text-bad">{a.lastError}</div>}
              </div>
              <div className="flex gap-2">
                {a.status !== 'active' && (
                  <Button size="sm" variant="primary" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={connect} title="Sign in with this same Google account again">
                    Reconnect
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Unplug className="h-3.5 w-3.5" />}
                  loading={disconnect.isPending && disconnect.variables === a.id}
                  onClick={() => confirm(`Disconnect ${a.email}? Its tokens are revoked; stored history is kept. Properties only this account can read stop syncing.`) && disconnect.mutate(a.id)}
                >
                  Disconnect
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">
        On Google’s screen, choose the account you want to add. While the OAuth app is in Testing, every account you add must also be listed under Google Auth Platform → Audience → Test users.
      </p>
    </Card>
  );
}
