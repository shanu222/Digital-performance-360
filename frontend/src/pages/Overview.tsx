import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Globe, Smartphone, MousePointerClick, Eye, Percent, Target, Users, Activity, DollarSign, MonitorPlay, AlertTriangle, TrendingDown, ArrowRight, Plug } from 'lucide-react';
import { api } from '../lib/api';
import { useRanged, type WebsiteRow, type AppRow, type Money } from '../lib/hooks';
import { fmtCompact, fmtMoney, fmtNum, fmtPct, fmtPos, fmtRatio } from '../lib/format';
import { Card, Change, DataTable, Empty, ErrorBox, Kpi, Notice, PageHeader, StatusBadge, Button } from '../components/ui';
import { MetricTrend, TrendChart } from '../components/charts';

interface OverviewData {
  websites: number;
  androidApps: number;
  search: { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null; clicksChangePct: number | null; impressionsChangePct: number | null; ctrChange: number | null; positionChange: number | null; freshDays: number };
  web: { activeUsersDailySum: number | null; sessions: number | null; sessionsChangePct: number | null; activeUsersChangePct: number | null };
  appActiveUsersDailySum: number | null;
  admob: Array<Money & { earningsChangePct: number | null; impressionsChangePct: number | null }>;
  appsRequiringAttention: Array<{ id: string; name: string; health: string; crashRate: number | null; anrRate: number | null }>;
  decliningWebsites: Array<{ id: string; name: string; clicksChangePct: number | null; sessionsChangePct: number | null }>;
  topWebsites: WebsiteRow[];
  topApps: AppRow[];
  timeseries: {
    search: Array<{ date: string; clicks: number | null; impressions: number | null; ctr: number | null; position: number | null }>;
    traffic: Array<{ date: string; activeUsers: number | null; sessions: number | null }>;
    revenue: Array<{ key: string; currency: string; earnings: number | null }>;
  };
}

export default function Overview() {
  const nav = useNavigate();
  const q = useRanged<OverviewData>('overview', '/api/overview');
  const integ = useQuery({ queryKey: ['integrations'], queryFn: () => api<{ google: { connected: boolean } }>('/api/integrations') });
  const d = q.data?.data;
  const loading = q.isLoading;
  const range = q.data?.meta?.range as { start: string; end: string } | undefined;
  const ad = d?.admob ?? [];
  const primaryCur = ad[0]?.currency;

  return (
    <div>
      <PageHeader
        eyebrow="Portfolio overview"
        title="Your digital business at a glance"
        subtitle={range ? `${range.start} → ${range.end} · compared with the previous period` : 'Loading period…'}
      />
      {integ.data && !integ.data.google.connected && (
        <div className="card mb-6 flex flex-col items-start gap-4 border-accent/40 p-5 md:flex-row md:items-center">
          <div className="rounded-xl bg-accent-soft p-3 text-accent">
            <Plug className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="font-bold">Connect Google to start collecting data</div>
            <div className="text-sm text-ink-2">No analytics are shown until your Search Console, Analytics and AdMob accounts are connected — nothing on this dashboard is sample data.</div>
          </div>
          <Link to="/onboarding">
            <Button variant="primary">Connect Google Account</Button>
          </Link>
        </div>
      )}
      {q.error && <ErrorBox error={q.error} retry={() => q.refetch()} />}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Kpi loading={loading} label="Websites" value={fmtNum(d?.websites)} icon={<Globe className="h-4 w-4" />} accent="cyan" />
        <Kpi loading={loading} label="Android apps" value={fmtNum(d?.androidApps)} icon={<Smartphone className="h-4 w-4" />} accent="cyan" />
        <Kpi loading={loading} label="Search clicks" value={fmtCompact(d?.search.clicks)} change={d?.search.clicksChangePct} icon={<MousePointerClick className="h-4 w-4" />} accent="blue" />
        <Kpi loading={loading} label="Impressions" value={fmtCompact(d?.search.impressions)} change={d?.search.impressionsChangePct} icon={<Eye className="h-4 w-4" />} accent="blue" />
        <Kpi loading={loading} label="Average CTR" value={fmtRatio(d?.search.ctr)} change={d?.search.ctrChange != null ? d.search.ctrChange * 100 : null} changeSuffix=" pts" icon={<Percent className="h-4 w-4" />} accent="blue" />
        <Kpi loading={loading} label="Avg position" value={fmtPos(d?.search.position)} change={d?.search.positionChange} changeSuffix=" pos" icon={<Target className="h-4 w-4" />} accent="blue" />
        <Kpi loading={loading} label="Website users" value={fmtCompact(d?.web.activeUsersDailySum)} change={d?.web.activeUsersChangePct} hint="sum of daily active" icon={<Users className="h-4 w-4" />} accent="cyan" />
        <Kpi loading={loading} label="App active users" value={fmtCompact(d?.appActiveUsersDailySum)} hint={d?.appActiveUsersDailySum == null ? 'link GA4/Firebase to apps' : 'sum of daily active'} icon={<Activity className="h-4 w-4" />} accent="cyan" />
        <Kpi
          loading={loading}
          label="AdMob est. earnings"
          value={ad.length ? fmtMoney(ad[0].earnings, ad[0].currency) : '—'}
          change={ad[0]?.earningsChangePct}
          hint={ad.length > 1 ? `+${ad.length - 1} other currency` : 'estimated'}
          icon={<DollarSign className="h-4 w-4" />}
          accent="gold"
        />
        <Kpi loading={loading} label="Ad impressions" value={fmtCompact(ad[0]?.impressions)} change={ad[0]?.impressionsChangePct} icon={<MonitorPlay className="h-4 w-4" />} accent="gold" />
        <Kpi loading={loading} label="Apps needing attention" value={fmtNum(d?.appsRequiringAttention.length)} icon={<AlertTriangle className="h-4 w-4" />} accent="gold" hint="crash / ANR thresholds" />
        <Kpi loading={loading} label="Declining websites" value={fmtNum(d?.decliningWebsites.length)} icon={<TrendingDown className="h-4 w-4" />} accent="gold" hint="≥10% drop" />
      </div>

      {(d?.search.freshDays ?? 0) > 0 && (
        <div className="mt-4">
          <Notice>Search Console data for the most recent {d!.search.freshDays} day(s) is preliminary and may still change.</Notice>
        </div>
      )}

      <div className="mt-6 grid gap-5 xl:grid-cols-3">
        <Card title="Search performance" subtitle="All monitored Search Console properties" source="Search Console" className="xl:col-span-2">
          <MetricTrend
            data={d?.timeseries.search ?? []}
            metrics={[
              { key: 'clicks', label: 'Clicks' },
              { key: 'impressions', label: 'Impressions' },
              { key: 'ctr', label: 'CTR', format: (v) => fmtRatio(v) },
              { key: 'position', label: 'Position', format: (v) => v.toFixed(1), reversed: true },
            ]}
          />
        </Card>
        <Card title="Needs attention" subtitle="From real thresholds and comparisons">
          {!d?.appsRequiringAttention.length && !d?.decliningWebsites.length ? (
            <Empty title="Nothing flagged">No declining websites or unhealthy apps in this period.</Empty>
          ) : (
            <ul className="space-y-2">
              {d?.decliningWebsites.map((w) => (
                <li key={w.id}>
                  <Link to={`/websites/${w.id}`} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5 hover:bg-surface-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <TrendingDown className="h-4 w-4 shrink-0 text-bad" />
                      <span className="truncate text-sm font-semibold">{w.name}</span>
                    </span>
                    <span className="flex gap-2">
                      {w.clicksChangePct != null && <Change value={w.clicksChangePct} />}
                    </span>
                  </Link>
                </li>
              ))}
              {d?.appsRequiringAttention.map((a) => (
                <li key={a.id}>
                  <Link to={`/apps/${a.id}`} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5 hover:bg-surface-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <Smartphone className="h-4 w-4 shrink-0 text-warn" />
                      <span className="truncate text-sm font-semibold">{a.name}</span>
                    </span>
                    <StatusBadge status={a.health} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="Website traffic" subtitle="Daily sessions and active users (GA4)" source="GA4">
          <TrendChart data={d?.timeseries.traffic ?? []} series={[{ key: 'sessions', name: 'Sessions' }, { key: 'activeUsers', name: 'Active users' }]} />
        </Card>
        <Card title="AdMob estimated earnings" subtitle={primaryCur ? `Daily, in ${primaryCur} (original reporting currency)` : 'Daily'} source="AdMob">
          <TrendChart
            data={(d?.timeseries.revenue ?? []).filter((r) => r.currency === primaryCur).map((r) => ({ date: r.key, earnings: r.earnings }))}
            series={[{ key: 'earnings', name: 'Estimated earnings' }]}
            format={(v) => fmtMoney(v, primaryCur ?? 'USD', v < 100 ? 2 : 0)}
          />
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="Top websites" pad={false} actions={<Link to="/websites" className="flex items-center gap-1 text-xs font-semibold text-accent">All websites <ArrowRight className="h-3 w-3" /></Link>}>
          <DataTable
            rows={d?.topWebsites ?? []}
            loading={loading}
            rowKey={(r) => r.id}
            onRowClick={(r) => nav(`/websites/${r.id}`)}
            empty={<Empty title="No websites yet">Select Search Console properties during onboarding.</Empty>}
            columns={[
              { key: 'name', header: 'Website', render: (r) => <div className="font-semibold">{r.name}</div> },
              { key: 'clicks', header: 'Clicks', align: 'right', render: (r) => fmtNum(r.clicks) },
              { key: 'chg', header: 'Δ', align: 'right', render: (r) => <Change value={r.clicksChangePct} /> },
              { key: 'sessions', header: 'Sessions', align: 'right', render: (r) => fmtNum(r.sessions) },
              { key: 'pos', header: 'Pos', align: 'right', render: (r) => fmtPos(r.position) },
            ]}
          />
        </Card>
        <Card title="Top earning apps" pad={false} actions={<Link to="/apps" className="flex items-center gap-1 text-xs font-semibold text-accent">All apps <ArrowRight className="h-3 w-3" /></Link>}>
          <DataTable
            rows={d?.topApps ?? []}
            loading={loading}
            rowKey={(r) => r.id}
            onRowClick={(r) => nav(`/apps/${r.id}`)}
            empty={<Empty title="No apps yet">Apps are discovered from AdMob and Google Play, or can be registered manually.</Empty>}
            columns={[
              { key: 'name', header: 'App', render: (r) => <div className="font-semibold">{r.name}</div> },
              { key: 'earn', header: 'Est. earnings', align: 'right', render: (r) => (r.earnings[0] ? fmtMoney(r.earnings[0].earnings, r.earnings[0].currency) : '—') },
              { key: 'ecpm', header: 'eCPM', align: 'right', render: (r) => (r.earnings[0] ? fmtMoney(r.earnings[0].ecpm, r.earnings[0].currency) : '—') },
              { key: 'crash', header: 'Crash', align: 'right', render: (r) => fmtPct(r.crashRate) },
              { key: 'h', header: 'Health', render: (r) => <StatusBadge status={r.health} /> },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}
