import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Pencil, Upload, FileDown } from 'lucide-react';
import { download, post } from '../lib/api';
import { useAction, useRanged, type Insight, type Money, type AppRow } from '../lib/hooks';
import { useRange, useToast, errMsg } from '../lib/context';
import { countryName, fmtCompact, fmtMoney, fmtNum, fmtPct, fmtRatio, titleCase, fmtAgo } from '../lib/format';
import { Button, Card, DataTable, Empty, ErrorBox, Kpi, Notice, PageHeader, Skeleton, StatusBadge } from '../components/ui';
import { BarList, MetricTrend, ShareBar, TrendChart } from '../components/charts';
import { InsightCard } from './AI';
import { AppForm } from './Apps';

interface Detail {
  app: { id: string; name: string; packageName: string; platform: string; source: string };
  playConsole: { id: string; displayName: string | null; syncStatus: string; lastSyncedAt: string | null; lastError: string | null } | null;
  admob: { id: string; appId: string; displayName: string | null; adUnits: Array<{ adUnitId: string; displayName: string; adFormat: string }> } | null;
  ga4: { id: string; displayName: string } | null;
  health: { status: string; crashRate: number | null; anrRate: number | null; thresholds: Record<string, number> };
  vitals: Array<{ metric: string; slice: string; value: number | null; latest: string }>;
  vitalsTimeseries: Array<Record<string, unknown>>;
  analytics: { current: { activeUsersDailySum: number | null; newUsers: number | null; sessions: number | null; engagementRate: number | null }; previous: { activeUsersDailySum: number | null; sessions: number | null }; timeseries: Array<Record<string, unknown>>; countries: Array<{ value: string; activeUsers: number | null }>; devices: Array<{ value: string; activeUsers: number | null }> } | null;
  revenue: { current: Array<Money & { earningsChangePct: number | null }>; daily: Array<{ key: string; currency: string; earnings: number | null }>; countries: Array<Money & { key: string }>; formats: Array<Money & { key: string }> } | null;
  acquisition: Array<{ metric: string; source: string; total: number; days: number }>;
  insights: Insight[];
}

const VITAL_LABELS: Record<string, string> = {
  crashRate: 'Crash rate',
  userPerceivedCrashRate: 'User-perceived crash rate',
  anrRate: 'ANR rate',
  userPerceivedAnrRate: 'User-perceived ANR rate',
  slowStartRate: 'Slow start rate',
  slowRenderingRate20Fps: 'Slow rendering (20 fps)',
  slowRenderingRate30Fps: 'Slow rendering (30 fps)',
  excessiveWakeupRate: 'Excessive wakeups',
  stuckBgWakelockRate: 'Stuck background wakelocks',
  errorReportCount: 'Error reports',
};

const pc = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : ((a - b) / b) * 100);

export default function AppDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { params } = useRange();
  const q = useRanged<Detail>(`app-${id}`, `/api/android-apps/${id}`);
  const [edit, setEdit] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const sync = useAction(() => post(`/api/android-apps/${id}/sync`), { success: 'Synchronization queued' });
  const importCsv = useAction(async (f: File) => post<{ imported: number; errors: string[] }>(`/api/android-apps/${id}/import`, { csv: await f.text(), fileName: f.name }), {
    success: (r) => `Imported ${r.imported} values${r.errors.length ? ` (${r.errors.length} rows skipped)` : ''}`,
    invalidate: [[`app-${id}`]],
  });
  const d = q.data?.data;
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  if (!d) return <Skeleton className="h-96" />;
  const rev = d.revenue?.current[0];
  const cur = rev?.currency ?? 'USD';
  const appLevel = d.vitals.filter((v) => !v.slice);
  const asRow = { id: d.app.id, name: d.app.name, packageName: d.app.packageName, playConsole: d.playConsole ? { id: d.playConsole.id } : null, admob: d.admob ? { id: d.admob.id } : null, ga4: d.ga4 ? { id: d.ga4.id } : null } as AppRow;

  return (
    <div>
      <Link to="/apps" className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" /> Applications</Link>
      <PageHeader
        eyebrow="Android application"
        title={d.app.name}
        subtitle={<span className="font-mono text-xs">{d.app.packageName}</span>}
        actions={
          <>
            <Button icon={<FileDown className="h-4 w-4" />} onClick={() => post<{ id: string; fileName: string }>('/api/reports/generate', { type: 'android_app', format: 'pdf', ...params, appId: id }).then((f) => download(`/api/reports/files/${f.id}/download`, f.fileName)).catch((e) => toast('error', errMsg(e)))}>App report</Button>
            <Button icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(true)}>Link sources</Button>
            <Button variant="primary" loading={sync.isPending} icon={<RefreshCw className="h-4 w-4" />} onClick={() => sync.mutate(undefined)}>Synchronize now</Button>
          </>
        }
      />
      <div className="mb-5 grid gap-3 md:grid-cols-3">
        {[
          ['Play Console', d.playConsole ? (d.playConsole.syncStatus === 'never' ? 'never_synced' : d.playConsole.syncStatus) : 'not_connected', d.playConsole?.lastSyncedAt],
          ['AdMob', d.admob ? 'connected' : 'not_connected', null],
          ['GA4 / Firebase', d.ga4 ? 'connected' : 'not_connected', null],
        ].map(([n, s, t]) => (
          <div key={n as string} className="card flex items-center gap-3 px-4 py-3 text-sm">
            <span className="font-semibold">{n}</span>
            <StatusBadge status={s as string} />
            {t && <span className="ml-auto text-[11px] text-muted">{fmtAgo(t as string)}</span>}
          </div>
        ))}
      </div>
      {d.playConsole?.lastError && <div className="mb-4"><Notice tone="warn">Play Reporting: {d.playConsole.lastError}</Notice></div>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Health" value={<StatusBadge status={d.health.status} />} hint={`crash ≥${d.health.thresholds.crashRateWarning}% / ANR ≥${d.health.thresholds.anrRateWarning}%`} accent="cyan" />
        <Kpi label="Crash rate" value={fmtPct(d.health.crashRate)} hint="% of users, weighted" accent="cyan" />
        <Kpi label="ANR rate" value={fmtPct(d.health.anrRate)} hint="% of users, weighted" accent="cyan" />
        <Kpi label="Active users" value={fmtCompact(d.analytics?.current.activeUsersDailySum)} change={pc(d.analytics?.current.activeUsersDailySum ?? null, d.analytics?.previous.activeUsersDailySum ?? null)} hint={d.analytics ? 'daily sum (GA4)' : 'link GA4/Firebase'} accent="blue" />
        <Kpi label="Est. earnings" value={rev ? fmtMoney(rev.earnings, cur) : '—'} change={rev?.earningsChangePct} hint="AdMob, estimated" accent="gold" />
        <Kpi label="eCPM" value={rev ? fmtMoney(rev.ecpm, cur) : '—'} hint={rev ? `match ${fmtPct(rev.matchRate, 1)}` : undefined} accent="gold" />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Stability trend" className="xl:col-span-2" source="Play Reporting API">
          {d.playConsole ? (
            <MetricTrend
              data={d.vitalsTimeseries}
              metrics={[
                { key: 'crashRate', label: 'Crash rate', format: (v) => `${v.toFixed(2)}%` },
                { key: 'anrRate', label: 'ANR rate', format: (v) => `${v.toFixed(2)}%` },
                { key: 'errorReportCount', label: 'Error reports' },
              ]}
            />
          ) : (
            <Empty title="Play Reporting not linked">Configure the Play service account in Integrations, then link this app.</Empty>
          )}
        </Card>
        <Card title="Android vitals" subtitle="User-weighted over the selected period">
          {appLevel.length ? (
            <ul className="divide-y divide-line text-sm">
              {appLevel.filter((v) => VITAL_LABELS[v.metric]).map((v) => (
                <li key={v.metric} className="flex justify-between py-2">
                  <span className="text-ink-2">{VITAL_LABELS[v.metric]}</span>
                  <span className="num font-bold">{v.metric === 'errorReportCount' ? fmtNum(v.value) : fmtPct(v.value)}</span>
                </li>
              ))}
              {d.vitals.filter((v) => v.metric === 'slowStartRate' && v.slice).map((v) => (
                <li key={v.slice} className="flex justify-between py-2">
                  <span className="text-ink-2">Slow start ({v.slice.split('=')[1]?.toLowerCase()})</span>
                  <span className="num font-bold">{fmtPct(v.value)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No vitals stored for this period" />
          )}
        </Card>
      </div>

      {d.analytics && (
        <div className="mt-5 grid gap-5 xl:grid-cols-3">
          <Card title="Active users & engagement" className="xl:col-span-2" source="GA4 / Firebase">
            <TrendChart data={d.analytics.timeseries} series={[{ key: 'activeUsers', name: 'Active users' }, { key: 'newUsers', name: 'New users' }]} />
          </Card>
          <Card title="Countries & devices">
            <BarList max={6} items={d.analytics.countries.map((c) => ({ key: c.value, label: c.value, value: c.activeUsers }))} />
            <div className="mt-5"><ShareBar items={d.analytics.devices.map((x) => ({ key: x.value, label: x.value, value: x.activeUsers }))} /></div>
            <div className="mt-3 text-xs text-muted">Engagement rate {fmtRatio(d.analytics.current.engagementRate, 1)}</div>
          </Card>
        </div>
      )}

      {d.revenue && (
        <div className="mt-5 grid gap-5 xl:grid-cols-3">
          <Card title="Daily estimated earnings" subtitle={`In ${cur}`} className="xl:col-span-2" source="AdMob">
            <TrendChart data={d.revenue.daily.filter((x) => x.currency === cur).map((x) => ({ date: x.key, earnings: x.earnings }))} series={[{ key: 'earnings', name: 'Earnings' }]} format={(v) => fmtMoney(v, cur)} />
          </Card>
          <Card title="Ad formats" pad={false}>
            <DataTable rows={d.revenue.formats} rowKey={(r) => r.key + r.currency} columns={[
              { key: 'f', header: 'Format', render: (r) => titleCase(r.key.toLowerCase()) },
              { key: 'e', header: 'Earnings', align: 'right', render: (r) => fmtMoney(r.earnings, r.currency) },
              { key: 'c', header: 'eCPM', align: 'right', render: (r) => fmtMoney(r.ecpm, r.currency) },
            ]} />
          </Card>
          <Card title="Revenue by country" className="xl:col-span-3">
            <BarList max={10} format={(v) => fmtMoney(v, cur)} items={d.revenue.countries.filter((c) => c.currency === cur).map((c) => ({ key: c.key, label: countryName(c.key), value: c.earnings, sub: `eCPM ${fmtMoney(c.ecpm, cur)}` }))} />
          </Card>
        </div>
      )}

      <Card
        className="mt-5"
        title="Acquisition / install metrics"
        subtitle="Play Console install statistics are not available through an approved reporting API — import the CSV export instead."
        actions={
          <>
            <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importCsv.mutate(f); e.target.value = ''; }} />
            <Button size="sm" loading={importCsv.isPending} icon={<Upload className="h-3.5 w-3.5" />} onClick={() => file.current?.click()}>Import CSV</Button>
          </>
        }
      >
        {d.acquisition.length ? (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {d.acquisition.map((a) => (
              <div key={a.metric + a.source} className="rounded-xl border border-line p-3">
                <div className="eyebrow">{a.metric}</div>
                <div className="num mt-1 text-xl font-extrabold">{fmtNum(a.total)}</div>
                <div className="truncate text-[11px] text-muted" title={a.source}>Source: {a.source.replace('csv_import:', 'CSV ')} · {a.days} days</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">
            No imported data. CSV format: <code className="font-mono">date,metric,value</code> or wide <code className="font-mono">date,installs,uninstalls,…</code> with dates as YYYY-MM-DD.
          </p>
        )}
      </Card>

      <Card className="mt-5" title="AI recommendations">
        {d.insights.length ? <div className="grid gap-3 lg:grid-cols-2">{d.insights.map((i) => <InsightCard key={i.id} i={i} />)}</div> : <Empty title="No recommendations yet" />}
      </Card>
      {edit && <AppForm initial={asRow} onClose={() => { setEdit(false); q.refetch(); }} />}
    </div>
  );
}
