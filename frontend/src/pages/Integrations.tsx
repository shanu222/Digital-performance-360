import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, BarChart3, DollarSign, Smartphone, Sparkles, Mail, RefreshCw, Unplug, Upload, Plus, ExternalLink, History } from 'lucide-react';
import { api, post, del } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useToast, errMsg } from '../lib/context';
import { fmtAgo, fmtDate } from '../lib/format';
import { Button, Card, DataTable, Field, Input, Modal, Notice, PageHeader, Select, StatusBadge, Skeleton } from '../components/ui';
import { PropertySelector } from './Onboarding';
import { GoogleAccountsCard, type GoogleAccount } from '../components/GoogleAccounts';

interface Svc { status: string; lastError?: string | null; lastCheckedAt?: string | null; lastSuccessAt?: string | null; serviceAccountEmail?: string | null; model?: string; provider?: string; scope?: string }
interface Integrations {
  google: { oauthConfigured: boolean; connected: boolean; email: string | null; status: string | null; scopes: string[]; accounts: GoogleAccount[] };
  services: Record<'search_console' | 'ga4' | 'admob' | 'play_reporting' | 'openai' | 'email', Svc>;
  counts: Record<string, number>;
}
interface Job { id: string; service: string; targetId: string; trigger: string; status: string; progress: number; attempts: number; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; result: Record<string, unknown> | null }

const SVC = [
  { key: 'search_console', name: 'Google Search Console', icon: Search, desc: 'Search analytics, sitemaps, URL inspection' },
  { key: 'ga4', name: 'Google Analytics 4', icon: BarChart3, desc: 'Data API + Admin API discovery + Realtime' },
  { key: 'admob', name: 'Google AdMob', icon: DollarSign, desc: 'Apps, ad units, network report' },
  { key: 'play_reporting', name: 'Play Developer Reporting', icon: Smartphone, desc: 'Android vitals via service account' },
  { key: 'openai', name: 'AI providers', icon: Sparkles, desc: 'OpenAI → Gemini → OpenRouter fallback · manage keys in Settings' },
  { key: 'email', name: 'Email delivery', icon: Mail, desc: 'Daily/weekly/monthly reports and critical alerts' },
] as const;

function Logs({ job, onClose }: { job: Job; onClose: () => void }) {
  const q = useQuery({ queryKey: ['logs', job.id], queryFn: () => api<Array<{ id: number; level: string; message: string; createdAt: string }>>(`/api/sync/jobs/${job.id}/logs`) });
  return (
    <Modal open onClose={onClose} title={`${job.service.replace('_', ' ')} · ${fmtDate(job.createdAt, true)}`} wide>
      {job.error && <div className="mb-3"><Notice tone="warn">{job.error}</Notice></div>}
      {q.isLoading ? <Skeleton className="h-40" /> : (
        <ul className="max-h-[50vh] space-y-1 overflow-y-auto font-mono text-xs">
          {q.data?.map((l) => (
            <li key={l.id} className={l.level === 'error' ? 'text-bad' : l.level === 'warn' ? 'text-warn' : 'text-ink-2'}>
              <span className="text-muted">{new Date(l.createdAt).toLocaleTimeString()}</span> {l.message}
            </li>
          ))}
          {!q.data?.length && <li className="text-muted">No log lines.</li>}
        </ul>
      )}
    </Modal>
  );
}

export default function IntegrationsPage() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api<Integrations>('/api/integrations'), refetchInterval: 20_000 });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api<Job[]>('/api/sync/jobs?limit=60'), refetchInterval: 8_000 });
  const fileRef = useRef<HTMLInputElement>(null);
  const [ga, setGa] = useState<{ open: boolean; id: string; name: string }>({ open: false, id: '', name: '' });
  const [backfill, setBackfill] = useState({ service: 'search_console', start: '', end: '' });
  const [logJob, setLogJob] = useState<Job | null>(null);
  const inv = [['integrations'], ['properties'], ['jobs'], ['sync-status']];

  const run = useAction((v: { service: string; start?: string; end?: string }) => post('/api/sync/run', v), { success: 'Job queued', invalidate: inv });
  const uploadSa = useAction(async (f: File) => post<{ clientEmail: string }>('/api/integrations/play-service-account', { json: await f.text() }), { success: (r) => `Service account ${r.clientEmail} saved (encrypted). Discovering apps…`, invalidate: inv });
  const removeSa = useAction(() => del('/api/integrations/play-service-account'), { success: 'Service account removed', invalidate: inv });
  const addGa = useAction(() => post('/api/integrations/ga4/manual', { propertyId: ga.id, displayName: ga.name }), { success: 'GA4 property added', invalidate: inv });

  const d = q.data;
  if (!d) return <Skeleton className="h-96" />;

  return (
    <div>
      <PageHeader eyebrow="System" title="Integrations" subtitle="Connection status, property selection and synchronization for every Google service." actions={<Button icon={<RefreshCw className="h-4 w-4" />} onClick={() => post('/api/integrations/discover').then(() => toast('info', 'Discovery queued')).catch((e) => toast('error', errMsg(e)))}>Re-discover properties</Button>} />

      <GoogleAccountsCard accounts={d.google.accounts ?? []} configured={d.google.oauthConfigured} />

      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {SVC.map((s) => {
          const v = d.services[s.key];
          return (
            <div key={s.key} className="card p-4">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-surface-2 p-2 text-cyan"><s.icon className="h-4.5 w-4.5" /></div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold">{s.name}</div>
                  <div className="text-xs text-muted">{s.desc}</div>
                </div>
                <StatusBadge status={v.status} />
              </div>
              <div className="mt-3 space-y-1 text-xs text-ink-2">
                {v.lastSuccessAt !== undefined && <div>Last successful sync: {fmtAgo(v.lastSuccessAt ?? null)}</div>}
                {v.serviceAccountEmail && <div className="truncate">Service account: <span className="font-mono">{v.serviceAccountEmail}</span></div>}
                {v.model && <div>Model: {v.model}</div>}
                {v.provider && <div>Provider: {v.provider}</div>}
                {v.lastError && <div className="text-bad">{v.lastError}</div>}
              </div>
              {['search_console', 'ga4', 'admob', 'play_reporting'].includes(s.key) && (
                <div className="mt-3 flex gap-2 border-t border-line pt-3">
                  <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} disabled={v.status === 'not_configured'} onClick={() => run.mutate({ service: s.key })}>Synchronize now</Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="Google Play Developer Reporting — guided setup" subtitle="OAuth does not grant Play access; a service account is required">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-2">
            <li>In Google Cloud Console, enable the <b>Google Play Developer Reporting API</b>.</li>
            <li>Create a service account and download its JSON key.</li>
            <li>In Play Console → Users and permissions, invite the service-account email and grant <b>View app information</b> for your apps.</li>
            <li>Upload the JSON key here (encrypted at rest), or set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64 on Railway.</li>
          </ol>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadSa.mutate(f); e.target.value = ''; }} />
            <Button variant="primary" loading={uploadSa.isPending} icon={<Upload className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>Upload service-account JSON</Button>
            {d.services.play_reporting.serviceAccountEmail && <Button variant="danger" onClick={() => removeSa.mutate(undefined)}>Remove</Button>}
          </div>
        </Card>
        <Card title="Manual configuration">
          <div className="space-y-4 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold">Add a GA4 property manually</div>
                <div className="text-xs text-muted">If Admin API discovery is not permitted for a property.</div>
              </div>
              <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setGa({ open: true, id: '', name: '' })}>Add property</Button>
            </div>
            <div className="border-t border-line pt-4">
              <div className="font-semibold">Backfill historical data</div>
              <div className="mb-3 text-xs text-muted">Re-fetches a date range (idempotent upserts). Search Console keeps ~16 months.</div>
              <div className="flex flex-wrap gap-2">
                <Select value={backfill.service} onChange={(e) => setBackfill({ ...backfill, service: e.target.value })} className="h-9">
                  <option value="search_console">Search Console</option>
                  <option value="ga4">GA4</option>
                  <option value="admob">AdMob</option>
                  <option value="play_reporting">Play vitals</option>
                </Select>
                <Input type="date" value={backfill.start} onChange={(e) => setBackfill({ ...backfill, start: e.target.value })} className="h-9" aria-label="Backfill start" />
                <Input type="date" value={backfill.end} onChange={(e) => setBackfill({ ...backfill, end: e.target.value })} className="h-9" aria-label="Backfill end" />
                <Button disabled={!backfill.start || !backfill.end || backfill.start > backfill.end} onClick={() => run.mutate(backfill)}>Queue backfill</Button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {d.google.connected && (
        <div className="mt-5">
          <h2 className="mb-3 text-lg font-extrabold">Monitored properties</h2>
          <PropertySelector />
        </div>
      )}

      <Card className="mt-5" title={<span className="flex items-center gap-2"><History className="h-4 w-4" />Synchronization history</span>} subtitle="Background jobs on the Railway worker — the dashboard never waits on them" pad={false}>
        <DataTable
          rows={jobs.data ?? []}
          loading={jobs.isLoading}
          rowKey={(r) => r.id}
          onRowClick={setLogJob}
          columns={[
            { key: 's', header: 'Service', render: (r) => <span className="font-semibold capitalize">{r.service.replace(/_/g, ' ')}</span> },
            { key: 'st', header: 'Status', render: (r) => (<div className="flex items-center gap-2"><StatusBadge status={r.status} />{r.status === 'running' && <span className="num text-xs text-muted">{r.progress}%</span>}</div>) },
            { key: 't', header: 'Trigger', render: (r) => <span className="text-xs capitalize text-ink-2">{r.trigger}</span> },
            { key: 'r', header: 'Result', render: (r) => <span className="block max-w-[360px] truncate text-xs text-muted" title={r.error ?? ''}>{r.error ?? (r.result ? `${r.result.synced ?? ''}${r.result.synced != null ? ' synced' : ''}${r.result.failed ? `, ${r.result.failed} failed` : ''}` : '')}</span> },
            { key: 'a', header: 'Attempts', align: 'right', render: (r) => r.attempts },
            { key: 'c', header: 'Created', render: (r) => <span className="text-xs text-muted">{fmtDate(r.createdAt, true)}</span> },
            { key: 'f', header: 'Finished', render: (r) => <span className="text-xs text-muted">{r.finishedAt ? fmtAgo(r.finishedAt) : '—'}</span> },
          ]}
        />
      </Card>

      <Modal open={ga.open} onClose={() => setGa({ ...ga, open: false })} title="Add GA4 property" footer={<><Button variant="ghost" onClick={() => setGa({ ...ga, open: false })}>Cancel</Button><Button variant="primary" disabled={!ga.id || !ga.name} loading={addGa.isPending} onClick={() => addGa.mutate(undefined, { onSuccess: () => setGa({ open: false, id: '', name: '' }) })}>Add</Button></>}>
        <div className="grid gap-4">
          <Field label="Property ID" hint="Numeric ID from GA4 Admin → Property settings (e.g. 412345678)."><Input value={ga.id} onChange={(e) => setGa({ ...ga, id: e.target.value.trim() })} /></Field>
          <Field label="Display name"><Input value={ga.name} onChange={(e) => setGa({ ...ga, name: e.target.value })} /></Field>
        </div>
      </Modal>
      {logJob && <Logs job={logJob} onClose={() => setLogJob(null)} />}
    </div>
  );
}
