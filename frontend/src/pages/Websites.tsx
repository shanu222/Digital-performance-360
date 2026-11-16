import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw, Pencil, Trash2, LayoutGrid, List, ExternalLink } from 'lucide-react';
import { api, post, patch, del } from '../lib/api';
import { useAction, useWebsites, type WebsiteRow } from '../lib/hooks';
import { fmtAgo, fmtNum, fmtPos, fmtRatio, fmtCompact } from '../lib/format';
import { Button, Card, Change, DataTable, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, StatusBadge, Tabs, Skeleton } from '../components/ui';

interface PropList {
  searchConsole: Array<{ id: string; siteUrl: string }>;
  ga4: Array<{ id: string; displayName: string; propertyName: string }>;
}

function Health({ score }: { score: number | null }) {
  if (score == null) return <span className="text-xs text-muted">—</span>;
  const status = score >= 70 ? 'healthy' : score >= 45 ? 'needs_attention' : 'critical';
  return <StatusBadge status={status} label={`${score}/100`} />;
}

export function WebsiteForm({ initial, onClose }: { initial?: WebsiteRow | null; onClose: () => void }) {
  const props = useQuery({ queryKey: ['properties'], queryFn: () => api<PropList>('/api/integrations/properties') });
  const [name, setName] = useState(initial?.name ?? '');
  const [domain, setDomain] = useState(initial?.domain ?? '');
  const [sc, setSc] = useState(initial?.searchConsole?.id ?? '');
  const [ga, setGa] = useState(initial?.ga4?.id ?? '');
  const save = useAction(
    () => {
      const body = { name, domain, searchConsolePropertyId: sc || null, ga4PropertyId: ga || null };
      return initial ? patch(`/api/websites/${initial.id}`, body) : post('/api/websites', body);
    },
    { success: initial ? 'Website updated' : 'Website added — synchronization queued', invalidate: [['websites'], ['website-list'], ['overview']] },
  );
  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? 'Edit website' : 'Add website'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!name || !domain} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Display name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="NET360 Preparation" />
        </Field>
        <Field label="Domain">
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" />
        </Field>
        <Field label="Search Console property" hint="Optional — a website can exist without it.">
          <Select value={sc} onChange={(e) => setSc(e.target.value)}>
            <option value="">Not connected</option>
            {props.data?.searchConsole.map((p) => (
              <option key={p.id} value={p.id}>
                {p.siteUrl}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="GA4 property" hint="Optional.">
          <Select value={ga} onChange={(e) => setGa(e.target.value)}>
            <option value="">Not connected</option>
            {props.data?.ga4.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} ({p.propertyName})
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

export default function Websites() {
  const nav = useNavigate();
  const q = useWebsites();
  const [view, setView] = useState<'table' | 'cards'>('table');
  const [form, setForm] = useState<WebsiteRow | null | undefined>(undefined);
  const [filter, setFilter] = useState('');
  const sync = useAction((id: string) => post(`/api/sync/website/${id}`), { success: 'Synchronization queued', invalidate: [['sync-status']] });
  const remove = useAction((id: string) => del(`/api/websites/${id}`), { success: 'Removed from monitoring (history kept)', invalidate: [['websites'], ['website-list']] });
  const rows = (q.data?.data ?? []).filter((w) => !filter || `${w.name} ${w.domain}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div>
      <PageHeader
        eyebrow="Website manager"
        title="Websites"
        subtitle="Every website with its Search Console and GA4 status shown independently."
        actions={
          <>
            <Input placeholder="Search websites…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-56" />
            <Tabs value={view} onChange={setView} items={[{ value: 'table', label: 'Table' }, { value: 'cards', label: 'Cards' }]} />
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setForm(null)}>
              Add website
            </Button>
          </>
        }
      />
      {q.error && <ErrorBox error={q.error} retry={() => q.refetch()} />}
      <div className="mb-4">
        <Notice>
          Websites appear here when you switch on their Search Console or GA4 property under <b>Integrations → Monitored properties</b>; GA4 web streams are matched to websites automatically. A site missing from Integrations means the connected Google account has no access to it — in Search Console open that property → Settings → Users and permissions → Add user (the connected Gmail, Full or Owner), then click <b>Re-discover properties</b>.
        </Notice>
      </div>
      {view === 'table' ? (
        <Card pad={false}>
          <DataTable
            rows={rows}
            loading={q.isLoading}
            rowKey={(r) => r.id}
            initialSort={{ key: 'clicks', dir: 'desc' }}
            onRowClick={(r) => nav(`/websites/${r.id}`)}
            empty={<Empty title="No websites yet" action={<Button variant="primary" onClick={() => setForm(null)}>Add website</Button>}>Websites are created automatically when you select Search Console properties, or add one manually.</Empty>}
            columns={[
              { key: 'name', header: 'Website', sortValue: (r) => r.name.toLowerCase(), render: (r) => (<div><div className="font-semibold">{r.name}</div><div className="text-xs text-muted">{r.domain}</div></div>) },
              { key: 'sc', header: 'Search Console', render: (r) => <StatusBadge status={r.searchConsole?.status ?? 'not_connected'} /> },
              { key: 'ga', header: 'GA4', render: (r) => <StatusBadge status={r.ga4?.status ?? 'not_connected'} /> },
              { key: 'clicks', header: 'Clicks', align: 'right', sortValue: (r) => r.clicks, render: (r) => (<div>{fmtNum(r.clicks)}<div><Change value={r.clicksChangePct} /></div></div>) },
              { key: 'imp', header: 'Impr.', align: 'right', sortValue: (r) => r.impressions, render: (r) => fmtCompact(r.impressions) },
              { key: 'ctr', header: 'CTR', align: 'right', sortValue: (r) => r.ctr, render: (r) => fmtRatio(r.ctr) },
              { key: 'pos', header: 'Pos', align: 'right', sortValue: (r) => r.position, render: (r) => fmtPos(r.position) },
              { key: 'users', header: 'Active users', align: 'right', sortValue: (r) => r.activeUsersDailySum, render: (r) => fmtCompact(r.activeUsersDailySum) },
              { key: 'health', header: 'SEO health', sortValue: (r) => r.seoHealth, render: (r) => <Health score={r.seoHealth} /> },
              { key: 'sync', header: 'Last sync', sortValue: (r) => r.lastSyncedAt, render: (r) => <span className="text-xs text-muted">{fmtAgo(r.lastSyncedAt)}</span> },
              {
                key: 'act',
                header: '',
                render: (r) => (
                  <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" variant="ghost" title="Synchronize now" onClick={() => sync.mutate(r.id)} icon={<RefreshCw className="h-3.5 w-3.5" />} />
                    <Button size="sm" variant="ghost" title="Edit" onClick={() => setForm(r)} icon={<Pencil className="h-3.5 w-3.5" />} />
                    <Button size="sm" variant="ghost" title="Remove from monitoring" onClick={() => confirm(`Remove ${r.name} from monitoring? Stored history is kept.`) && remove.mutate(r.id)} icon={<Trash2 className="h-3.5 w-3.5" />} />
                  </div>
                ),
              },
            ]}
          />
        </Card>
      ) : q.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-48" />)}</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((w) => (
            <div key={w.id} className="card fade-in cursor-pointer p-5 transition-colors hover:border-line-strong" onClick={() => nav(`/websites/${w.id}`)}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-bold">{w.name}</div>
                  <a href={`https://${w.domain}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 text-xs text-muted hover:text-accent">
                    {w.domain} <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <Health score={w.seoHealth} />
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3">
                <div><div className="eyebrow">Clicks</div><div className="num mt-1 text-lg font-extrabold">{fmtCompact(w.clicks)}</div><Change value={w.clicksChangePct} /></div>
                <div><div className="eyebrow">CTR</div><div className="num mt-1 text-lg font-extrabold">{fmtRatio(w.ctr)}</div></div>
                <div><div className="eyebrow">Users</div><div className="num mt-1 text-lg font-extrabold">{fmtCompact(w.activeUsersDailySum)}</div><Change value={w.sessionsChangePct} /></div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                <StatusBadge status={w.searchConsole?.status ?? 'not_connected'} label={`SC: ${w.searchConsole ? (w.searchConsole.status === 'connected' ? 'OK' : w.searchConsole.status.replace('_', ' ')) : 'off'}`} />
                <StatusBadge status={w.ga4?.status ?? 'not_connected'} label={`GA4: ${w.ga4 ? (w.ga4.status === 'connected' ? 'OK' : w.ga4.status.replace('_', ' ')) : 'off'}`} />
                <span className="ml-auto text-[11px] text-muted">{fmtAgo(w.lastSyncedAt)}</span>
              </div>
            </div>
          ))}
          {!rows.length && <Card className="md:col-span-3"><Empty title="No websites yet" /></Card>}
        </div>
      )}
      {form !== undefined && <WebsiteForm initial={form} onClose={() => setForm(undefined)} />}
    </div>
  );
}
