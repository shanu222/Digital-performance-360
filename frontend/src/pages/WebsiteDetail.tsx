import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Pencil, ExternalLink, FileDown } from 'lucide-react';
import { download, post } from '../lib/api';
import { useAction, useRanged, type Insight, type WebsiteRow } from '../lib/hooks';
import { useRange, useToast, errMsg } from '../lib/context';
import { countryName, fmtCompact, fmtDate, fmtDuration, fmtNum, fmtPos, fmtRatio, fmtAgo } from '../lib/format';
import { Button, Card, Change, DataTable, Empty, ErrorBox, Kpi, Notice, PageHeader, StatusBadge, Skeleton } from '../components/ui';
import { BarList, MetricTrend, TrendChart } from '../components/charts';
import { InsightCard } from './AI';
import { WebsiteForm } from './Websites';

interface Totals { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null; freshDays: number }
interface Ga { activeUsersDailySum: number | null; newUsers: number | null; sessions: number | null; engagementRate: number | null; avgEngagementTimeSec: number | null; screenPageViews: number | null; keyEvents: number | null }
interface Row { key: string; clicks: number | null; impressions: number | null; ctr: number | null; position: number | null; positionChange: number | null; clickChangePct: number | null }
interface Detail {
  website: { id: string; name: string; domain: string };
  searchConsole: { id: string; siteUrl: string; syncStatus: string; lastSyncedAt: string | null; lastError: string | null } | null;
  ga4: { id: string; displayName: string; propertyName: string; syncStatus: string; lastSyncedAt: string | null; lastError: string | null } | null;
  seo: { current: Totals; previous: Totals; timeseries: Array<Record<string, unknown>>; keywords: Row[]; pages: Row[]; countries: Array<{ value: string; clicks: number | null }> };
  traffic: { current: Ga; previous: Ga; timeseries: Array<Record<string, unknown>>; countries: Array<{ value: string; sessions: number | null }> };
  sitemaps: Array<{ id: number; path: string; errors: number | null; warnings: number | null; lastDownloaded: string | null; isPending: boolean | null }>;
  inspections: Array<{ id: number; url: string; verdict: string | null; coverageState: string | null; inspectedAt: string }>;
  insights: Insight[];
}

const pc = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : ((a - b) / b) * 100);

export default function WebsiteDetail() {
  const { id } = useParams();
  const { params } = useRange();
  const toast = useToast();
  const q = useRanged<Detail>(`website-${id}`, `/api/websites/${id}`);
  const [edit, setEdit] = useState(false);
  const sync = useAction(() => post(`/api/sync/website/${id}`), { success: 'Synchronization queued' });
  const d = q.data?.data;
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  if (!d) return <Skeleton className="h-96" />;
  const s = d.seo.current;
  const p = d.seo.previous;
  const g = d.traffic.current;
  const gp = d.traffic.previous;

  const report = (type: string) =>
    post<{ id: string; fileName: string }>('/api/reports/generate', { type, format: 'pdf', ...params, websiteId: id })
      .then((f) => download(`/api/reports/files/${f.id}/download`, f.fileName))
      .catch((e) => toast('error', errMsg(e)));

  const asRow: WebsiteRow = { id: d.website.id, name: d.website.name, domain: d.website.domain, searchConsole: d.searchConsole ? { id: d.searchConsole.id, siteUrl: d.searchConsole.siteUrl, status: 'connected', lastSyncedAt: null, lastError: null } : null, ga4: d.ga4 ? { id: d.ga4.id, name: d.ga4.displayName, propertyName: d.ga4.propertyName, status: 'connected', lastSyncedAt: null, lastError: null } : null } as WebsiteRow;

  return (
    <div>
      <Link to="/websites" className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" /> Websites
      </Link>
      <PageHeader
        eyebrow="Website dashboard"
        title={d.website.name}
        subtitle={
          <a href={`https://${d.website.domain}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-accent">
            {d.website.domain} <ExternalLink className="h-3 w-3" />
          </a>
        }
        actions={
          <>
            <Button icon={<FileDown className="h-4 w-4" />} onClick={() => report('website_seo')}>SEO report</Button>
            <Button icon={<FileDown className="h-4 w-4" />} onClick={() => report('website_traffic')} disabled={!d.ga4}>Traffic report</Button>
            <Button icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(true)}>Edit</Button>
            <Button variant="primary" loading={sync.isPending} icon={<RefreshCw className="h-4 w-4" />} onClick={() => sync.mutate(undefined)}>Synchronize now</Button>
          </>
        }
      />
      <div className="mb-5 grid gap-3 md:grid-cols-2">
        <div className="card flex items-center gap-3 px-4 py-3 text-sm">
          <span className="font-semibold">Search Console</span>
          <StatusBadge status={d.searchConsole ? (d.searchConsole.syncStatus === 'never' ? 'never_synced' : d.searchConsole.syncStatus) : 'not_connected'} />
          <span className="truncate text-xs text-muted">{d.searchConsole?.siteUrl}</span>
          <span className="ml-auto text-[11px] text-muted">{d.searchConsole && fmtAgo(d.searchConsole.lastSyncedAt)}</span>
        </div>
        <div className="card flex items-center gap-3 px-4 py-3 text-sm">
          <span className="font-semibold">GA4</span>
          <StatusBadge status={d.ga4 ? (d.ga4.syncStatus === 'never' ? 'never_synced' : d.ga4.syncStatus) : 'not_connected'} />
          <span className="truncate text-xs text-muted">{d.ga4?.displayName}</span>
          <span className="ml-auto text-[11px] text-muted">{d.ga4 && fmtAgo(d.ga4.lastSyncedAt)}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Clicks" value={fmtCompact(s.clicks)} change={pc(s.clicks, p.clicks)} accent="blue" />
        <Kpi label="Impressions" value={fmtCompact(s.impressions)} change={pc(s.impressions, p.impressions)} accent="blue" />
        <Kpi label="CTR" value={fmtRatio(s.ctr)} change={s.ctr != null && p.ctr != null ? (s.ctr - p.ctr) * 100 : null} changeSuffix=" pts" accent="blue" />
        <Kpi label="Avg position" value={fmtPos(s.position)} change={s.position != null && p.position != null ? p.position - s.position : null} changeSuffix=" pos" accent="blue" />
        <Kpi label="Sessions" value={fmtCompact(g.sessions)} change={pc(g.sessions, gp.sessions)} accent="cyan" />
        <Kpi label="Active users" value={fmtCompact(g.activeUsersDailySum)} change={pc(g.activeUsersDailySum, gp.activeUsersDailySum)} hint="daily sum" accent="cyan" />
        <Kpi label="Engagement" value={fmtRatio(g.engagementRate, 1)} hint={`avg ${fmtDuration(g.avgEngagementTimeSec)}`} accent="cyan" />
        <Kpi label="Key events" value={fmtCompact(g.keyEvents)} change={pc(g.keyEvents, gp.keyEvents)} accent="gold" />
      </div>
      {s.freshDays > 0 && <div className="mt-3"><Notice>Includes {s.freshDays} day(s) of preliminary Search Console data.</Notice></div>}
      {d.searchConsole?.lastError && <div className="mt-3"><Notice tone="warn">Search Console: {d.searchConsole.lastError}</Notice></div>}
      {d.ga4?.lastError && <div className="mt-3"><Notice tone="warn">GA4: {d.ga4.lastError}</Notice></div>}

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="Search trend" source="Search Console">
          {d.searchConsole ? (
            <MetricTrend data={d.seo.timeseries} metrics={[{ key: 'clicks', label: 'Clicks' }, { key: 'impressions', label: 'Impressions' }, { key: 'ctr', label: 'CTR', format: (v) => fmtRatio(v) }, { key: 'position', label: 'Position', format: (v) => v.toFixed(1), reversed: true }]} />
          ) : (
            <Empty title="Search Console not connected" action={<Button onClick={() => setEdit(true)}>Connect property</Button>} />
          )}
        </Card>
        <Card title="Traffic trend" source="GA4">
          {d.ga4 ? <TrendChart data={d.traffic.timeseries} series={[{ key: 'sessions', name: 'Sessions' }, { key: 'activeUsers', name: 'Active users' }]} /> : <Empty title="GA4 not connected" action={<Button onClick={() => setEdit(true)}>Connect property</Button>} />}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="Top keywords" pad={false} actions={<Link to={`/keywords?websiteId=${id}`} className="text-xs font-semibold text-accent">All keywords →</Link>}>
          <DataTable rows={d.seo.keywords} rowKey={(r) => r.key} columns={[
            { key: 'k', header: 'Keyword', render: (r) => <span className="font-medium">{r.key}</span> },
            { key: 'c', header: 'Clicks', align: 'right', render: (r) => fmtNum(r.clicks) },
            { key: 'p', header: 'Pos', align: 'right', render: (r) => fmtPos(r.position) },
            { key: 'd', header: 'Δ pos', align: 'right', render: (r) => <Change value={r.positionChange} suffix="" /> },
          ]} />
        </Card>
        <Card title="Top pages" pad={false} actions={<Link to={`/pages?websiteId=${id}`} className="text-xs font-semibold text-accent">All pages →</Link>}>
          <DataTable rows={d.seo.pages} rowKey={(r) => r.key} columns={[
            { key: 'k', header: 'Page', render: (r) => <span className="block max-w-[340px] truncate font-medium" title={r.key}>{r.key.replace(/^https?:\/\/[^/]+/, '') || '/'}</span> },
            { key: 'c', header: 'Clicks', align: 'right', render: (r) => fmtNum(r.clicks) },
            { key: 'ch', header: 'Δ', align: 'right', render: (r) => <Change value={r.clickChangePct} /> },
            { key: 'p', header: 'Pos', align: 'right', render: (r) => fmtPos(r.position) },
          ]} />
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Countries (search clicks)" source="Search Console">
          <BarList items={d.seo.countries.map((c) => ({ key: c.value, label: countryName(c.value), value: c.clicks }))} />
        </Card>
        <Card title="Countries (sessions)" source="GA4">
          <BarList items={d.traffic.countries.map((c) => ({ key: c.value, label: c.value, value: c.sessions }))} />
        </Card>
        <Card title="Indexing observations" source="Sitemaps · URL Inspection">
          {d.sitemaps.length ? (
            <ul className="space-y-2 text-sm">
              {d.sitemaps.map((m) => (
                <li key={m.id} className="flex items-center gap-2">
                  <StatusBadge status={(m.errors ?? 0) > 0 ? 'error' : (m.warnings ?? 0) > 0 ? 'warning' : 'success'} label={(m.errors ?? 0) > 0 ? `${m.errors} errors` : (m.warnings ?? 0) > 0 ? `${m.warnings} warnings` : 'OK'} />
                  <span className="truncate text-xs" title={m.path}>{m.path}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No sitemaps submitted in Search Console.</p>
          )}
          <div className="mt-4 border-t border-line pt-3">
            <div className="eyebrow mb-2">Recent URL inspections</div>
            {d.inspections.length ? (
              d.inspections.slice(0, 5).map((i) => (
                <div key={i.id} className="flex items-center gap-2 py-1 text-xs">
                  <StatusBadge status={i.verdict === 'PASS' ? 'success' : i.verdict === 'FAIL' ? 'error' : 'warning'} label={i.verdict ?? '—'} />
                  <span className="truncate" title={i.url}>{i.url.replace(/^https?:\/\/[^/]+/, '')}</span>
                  <span className="ml-auto shrink-0 text-muted">{fmtDate(i.inspectedAt)}</span>
                </div>
              ))
            ) : (
              <Link to="/indexing" className="text-xs text-accent">Inspect a URL →</Link>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-5">
        <Card title="AI recommendations" subtitle="Generated from this website’s stored data">
          {d.insights.length ? <div className="grid gap-3 lg:grid-cols-2">{d.insights.map((i) => <InsightCard key={i.id} i={i} />)}</div> : <Empty title="No recommendations yet">They are generated with the daily report once AI is configured.</Empty>}
        </Card>
      </div>
      {edit && <WebsiteForm initial={asRow} onClose={() => { setEdit(false); q.refetch(); }} />}
    </div>
  );
}
