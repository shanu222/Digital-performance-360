import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { api, post } from '../lib/api';
import { useAction, useRanged, type AppRow } from '../lib/hooks';
import { fmtAgo, fmtCompact, fmtMoney, fmtPct } from '../lib/format';
import { Button, Card, Change, DataTable, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, StatusBadge } from '../components/ui';

interface Props {
  ga4: Array<{ id: string; displayName: string; propertyName: string }>;
  admobApps: Array<{ id: string; displayName: string | null; appId: string; storeId: string | null }>;
  playApps: Array<{ id: string; displayName: string | null; packageName: string }>;
}

export function AppForm({ initial, onClose }: { initial?: AppRow | null; onClose: () => void }) {
  const props = useQuery({ queryKey: ['properties'], queryFn: () => api<Props>('/api/integrations/properties') });
  const [name, setName] = useState(initial?.name ?? '');
  const [pkg, setPkg] = useState(initial?.packageName ?? '');
  const [play, setPlay] = useState(initial?.playConsole?.id ?? '');
  const [admob, setAdmob] = useState(initial?.admob?.id ?? '');
  const [ga, setGa] = useState(initial?.ga4?.id ?? '');
  const save = useAction(
    () => {
      const body = { name, packageName: pkg, playConsoleAppId: play || null, admobAppId: admob || null, ga4PropertyId: ga || null };
      return initial ? api(`/api/android-apps/${initial.id}`, { method: 'PATCH', json: body }) : post('/api/android-apps', body);
    },
    { success: 'Application saved', invalidate: [['apps'], ['overview']] },
  );
  return (
    <Modal open onClose={onClose} title={initial ? 'Edit application' : 'Register Android application'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name || !pkg} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>Save</Button></>}>
      <div className="grid gap-4">
        <Field label="App name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Package name" hint="e.g. com.company.app — Play and AdMob apps with this package are linked automatically.">
          <Input value={pkg} onChange={(e) => setPkg(e.target.value.trim())} disabled={Boolean(initial)} />
        </Field>
        <Field label="Google Play (vitals)">
          <Select value={play} onChange={(e) => setPlay(e.target.value)}>
            <option value="">Not linked</option>
            {props.data?.playApps.map((p) => <option key={p.id} value={p.id}>{p.displayName ?? p.packageName} ({p.packageName})</option>)}
          </Select>
        </Field>
        <Field label="AdMob app">
          <Select value={admob} onChange={(e) => setAdmob(e.target.value)}>
            <option value="">Not linked</option>
            {props.data?.admobApps.map((p) => <option key={p.id} value={p.id}>{p.displayName ?? p.appId}</option>)}
          </Select>
        </Field>
        <Field label="GA4 / Firebase property" hint="For active users and engagement.">
          <Select value={ga} onChange={(e) => setGa(e.target.value)}>
            <option value="">Not linked</option>
            {props.data?.ga4.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

export default function Apps() {
  const nav = useNavigate();
  const q = useRanged<AppRow[]>('apps', '/api/android-apps');
  const [form, setForm] = useState<AppRow | null | undefined>(undefined);
  const sync = useAction((id: string) => post(`/api/android-apps/${id}/sync`), { success: 'Synchronization queued' });
  return (
    <div>
      <PageHeader
        eyebrow="Android"
        title="Android Applications"
        subtitle="Apps discovered from Google Play and AdMob, plus manually registered apps."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setForm(null)}>Register app</Button>}
      />
      {q.error && <ErrorBox error={q.error} retry={() => q.refetch()} />}
      <Card pad={false}>
        <DataTable
          rows={q.data?.data ?? []}
          loading={q.isLoading}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/apps/${r.id}`)}
          initialSort={{ key: 'earn', dir: 'desc' }}
          empty={<Empty title="No applications yet" action={<Button variant="primary" onClick={() => setForm(null)}>Register app</Button>}>Apps are discovered automatically from AdMob (linked store listings) and the Play Developer Reporting API.</Empty>}
          columns={[
            { key: 'n', header: 'Application', sortValue: (r) => r.name.toLowerCase(), render: (r) => (<div><div className="font-semibold">{r.name}</div><div className="font-mono text-[11px] text-muted">{r.packageName}</div></div>) },
            { key: 'h', header: 'Health', sortValue: (r) => ({ critical: 0, needs_attention: 1, healthy: 2, no_data: 3 })[r.health] ?? 4, render: (r) => <StatusBadge status={r.health} /> },
            {
              key: 'i',
              header: 'Integrations',
              render: (r) => (
                <div className="flex flex-wrap gap-1 text-[10.5px] font-bold">
                  <span className={r.playConsole ? 'rounded bg-good-soft px-1.5 py-0.5 text-good' : 'rounded bg-surface-3 px-1.5 py-0.5 text-muted'}>Play</span>
                  <span className={r.admob ? 'rounded bg-good-soft px-1.5 py-0.5 text-good' : 'rounded bg-surface-3 px-1.5 py-0.5 text-muted'}>AdMob</span>
                  <span className={r.ga4 ? 'rounded bg-good-soft px-1.5 py-0.5 text-good' : 'rounded bg-surface-3 px-1.5 py-0.5 text-muted'}>GA4</span>
                </div>
              ),
            },
            { key: 'u', header: 'Active users', align: 'right', sortValue: (r) => r.activeUsersDailySum, render: (r) => fmtCompact(r.activeUsersDailySum) },
            { key: 'c', header: 'Crash rate', align: 'right', sortValue: (r) => r.crashRate, render: (r) => fmtPct(r.crashRate) },
            { key: 'a', header: 'ANR rate', align: 'right', sortValue: (r) => r.anrRate, render: (r) => fmtPct(r.anrRate) },
            { key: 'earn', header: 'Est. earnings', align: 'right', sortValue: (r) => r.earnings[0]?.earnings ?? null, render: (r) => (r.earnings.length ? (<div>{r.earnings.map((e) => <div key={e.currency}>{fmtMoney(e.earnings, e.currency)}</div>)}<Change value={r.earningsChangePct} /></div>) : '—') },
            { key: 's', header: 'Last sync', render: (r) => <span className="text-xs text-muted">{fmtAgo(r.lastSyncedAt)}</span> },
            { key: 'x', header: '', render: (r) => <div onClick={(e) => e.stopPropagation()}><Button size="sm" variant="ghost" title="Synchronize now" onClick={() => sync.mutate(r.id)} icon={<RefreshCw className="h-3.5 w-3.5" />} /></div> },
          ]}
        />
      </Card>
      {form !== undefined && <AppForm initial={form} onClose={() => setForm(undefined)} />}
    </div>
  );
}
