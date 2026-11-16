import { Link } from 'react-router-dom';
import { HeartPulse } from 'lucide-react';
import { useRanged } from '../lib/hooks';
import { fmtNum, fmtPct, fmtDate } from '../lib/format';
import { Button, Card, Change, DataTable, Empty, ErrorBox, Kpi, Notice, PageHeader, StatusBadge } from '../components/ui';

interface Row {
  playApp: { id: string; displayName: string | null; packageName: string; syncStatus: string; lastError: string | null };
  androidAppId: string | null;
  status: string;
  metrics: Record<string, number | null>;
  slowStart: Array<{ slice: string; value: number | null }>;
  previous: { crashRate: number | null; anrRate: number | null };
  latestDate: string | null;
}

const delta = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? null : a - b);

export default function PlayHealth() {
  const q = useRanged<Row[]>('app-health', '/api/app-health');
  const rows = q.data?.data ?? [];
  const t = q.data?.meta?.thresholds as Record<string, number> | undefined;
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return (
    <div>
      <PageHeader eyebrow="Google Play Developer Reporting" title="Google Play Health" subtitle="Android vitals per app, classified by your configurable thresholds." actions={<Link to="/settings"><Button>Edit thresholds</Button></Link>} />
      {q.error && <ErrorBox error={q.error} retry={() => q.refetch()} />}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Kpi loading={q.isLoading} label="Monitored apps" value={fmtNum(rows.length)} accent="cyan" icon={<HeartPulse className="h-4 w-4" />} />
        <Kpi loading={q.isLoading} label="Healthy" value={fmtNum(count('healthy'))} accent="cyan" />
        <Kpi loading={q.isLoading} label="Needs attention" value={fmtNum(count('needs_attention'))} accent="gold" />
        <Kpi loading={q.isLoading} label="Critical" value={fmtNum(count('critical'))} accent="gold" />
      </div>
      <div className="mt-4">
        <Notice>
          {String(q.data?.meta?.note ?? 'Rates are % of distinct users; Play data typically lags 1–2 days.')}
          {t && ` Thresholds — crash: warning ${t.crashRateWarning}%, critical ${t.crashRateCritical}%; ANR: warning ${t.anrRateWarning}%, critical ${t.anrRateCritical}%.`} Acquisition and financial statistics are not part of this API.
        </Notice>
      </div>
      <Card className="mt-5" pad={false} title="Technical stability by application">
        <DataTable
          rows={rows}
          loading={q.isLoading}
          rowKey={(r) => r.playApp.id}
          initialSort={{ key: 'status', dir: 'asc' }}
          empty={<Empty title="No Play apps monitored" action={<Link to="/integrations"><Button variant="primary">Set up Play Reporting</Button></Link>}>Add the Play service account and select apps on the Integrations page.</Empty>}
          columns={[
            { key: 'app', header: 'App', sortValue: (r) => r.playApp.displayName ?? r.playApp.packageName, render: (r) => (<div>{r.androidAppId ? <Link to={`/apps/${r.androidAppId}`} className="font-semibold hover:text-accent">{r.playApp.displayName ?? r.playApp.packageName}</Link> : <span className="font-semibold">{r.playApp.displayName ?? r.playApp.packageName}</span>}<div className="font-mono text-[11px] text-muted">{r.playApp.packageName}</div></div>) },
            { key: 'status', header: 'Status', sortValue: (r) => ({ critical: 0, needs_attention: 1, healthy: 2, no_data: 3 })[r.status] ?? 4, render: (r) => <StatusBadge status={r.status} /> },
            { key: 'crash', header: 'Crash rate', align: 'right', sortValue: (r) => r.metrics.crashRate, render: (r) => (<div>{fmtPct(r.metrics.crashRate)}<div><Change value={delta(r.metrics.crashRate, r.previous.crashRate)} invert suffix=" pts" digits={2} /></div></div>) },
            { key: 'pcrash', header: 'User-perceived crash', align: 'right', sortValue: (r) => r.metrics.userPerceivedCrashRate, render: (r) => fmtPct(r.metrics.userPerceivedCrashRate) },
            { key: 'anr', header: 'ANR rate', align: 'right', sortValue: (r) => r.metrics.anrRate, render: (r) => (<div>{fmtPct(r.metrics.anrRate)}<div><Change value={delta(r.metrics.anrRate, r.previous.anrRate)} invert suffix=" pts" digits={2} /></div></div>) },
            { key: 'slowstart', header: 'Slow start (cold)', align: 'right', render: (r) => fmtPct(r.slowStart.find((s) => s.slice.includes('COLD'))?.value) },
            { key: 'render', header: 'Slow rendering', align: 'right', sortValue: (r) => r.metrics.slowRenderingRate20Fps, render: (r) => fmtPct(r.metrics.slowRenderingRate20Fps) },
            { key: 'wake', header: 'Excessive wakeups', align: 'right', sortValue: (r) => r.metrics.excessiveWakeupRate, render: (r) => fmtPct(r.metrics.excessiveWakeupRate) },
            { key: 'err', header: 'Error reports', align: 'right', sortValue: (r) => r.metrics.errorReportCount, render: (r) => fmtNum(r.metrics.errorReportCount) },
            { key: 'latest', header: 'Data through', render: (r) => <span className="text-xs text-muted">{fmtDate(r.latestDate)}</span> },
          ]}
        />
      </Card>
    </div>
  );
}
