import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Radio } from 'lucide-react';
import { api, apiRaw, qs } from '../lib/api';
import { useRanged, WebsitePicker } from '../lib/hooks';
import { fmtCompact, fmtDuration, fmtNum, fmtRatio, fmtAgo } from '../lib/format';
import { Card, Change, DataTable, Empty, ErrorBox, Kpi, Notice, PageHeader, Tabs } from '../components/ui';
import { BarList, MetricTrend, ShareBar } from '../components/charts';

interface Ga { activeUsersDailySum: number | null; newUsers: number | null; sessions: number | null; engagedSessions: number | null; engagementRate: number | null; avgEngagementTimeSec: number | null; screenPageViews: number | null; eventCount: number | null; keyEvents: number | null; totalRevenue: number | null; revenueCurrency: string | null }
interface Bd { value: string; activeUsers: number | null; sessions: number | null; engagedSessions: number | null; engagementRate: number | null; keyEvents: number | null; screenPageViews: number | null; newUsers: number | null }
interface Summary {
  current: Ga;
  previous: Ga;
  live: Record<string, number | null> | null;
  change: Record<string, number | null>;
  timeseries: Array<Record<string, unknown>>;
  countries: Bd[];
  devices: Bd[];
  channels: Bd[];
  pages: Bd[];
}
interface Cmp { current: { start: string; end: string }; sessions: { current: number | null; previous: number | null; change: number | null }; activeUsers: { current: number | null; change: number | null }; views: { current: number | null; change: number | null }; keyEvents: { current: number | null; change: number | null }; partial: boolean }

function Realtime({ websiteId }: { websiteId: string }) {
  const q = useQuery({ queryKey: ['realtime', websiteId], queryFn: () => api<{ activeUsers30m: number | null; topCountries: Array<{ name: string; activeUsers: number }>; topPages: Array<{ name: string; activeUsers: number }>; fetchedAt: string }>(`/api/analytics/realtime${qs({ websiteId })}`), refetchInterval: 60_000, retry: false });
  if (q.error) return <p className="text-sm text-muted">Realtime unavailable: {(q.error as Error).message}</p>;
  const d = q.data;
  return (
    <div>
      <div className="flex items-end gap-3">
        <div className="num text-4xl font-extrabold">{d ? fmtNum(d.activeUsers30m) : '…'}</div>
        <div className="pb-1 text-xs text-muted">active users · last 30 min · {d && fmtAgo(d.fetchedAt)}</div>
      </div>
      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <div>
          <div className="eyebrow mb-2">Top countries</div>
          <BarList items={(d?.topCountries ?? []).map((c) => ({ key: c.name, label: c.name, value: c.activeUsers }))} max={5} />
        </div>
        <div>
          <div className="eyebrow mb-2">Top pages / screens</div>
          <BarList items={(d?.topPages ?? []).map((c) => ({ key: c.name, label: c.name, value: c.activeUsers }))} max={5} />
        </div>
      </div>
      <p className="mt-3 text-[11px] text-muted">Traffic sources are not offered by the GA4 Realtime API.</p>
    </div>
  );
}

export default function Traffic() {
  const [websiteId, setWebsiteId] = useState('');
  const [countryMetric, setCountryMetric] = useState<'sessions' | 'activeUsers'>('sessions');
  const q = useRanged<Summary>('analytics', '/api/analytics/summary', { websiteId });
  const cmp = useQuery({ queryKey: ['cmp', websiteId], queryFn: () => apiRaw<Record<string, Cmp>>(`/api/analytics/comparisons${qs({ websiteId })}`), enabled: Boolean(websiteId) });
  const d = q.data?.data;
  const live = d?.live;
  return (
    <div>
      <PageHeader eyebrow="Google Analytics 4" title="Traffic Analytics" subtitle="Users, sessions, engagement, acquisition and geography." actions={<WebsitePicker value={websiteId} onChange={setWebsiteId} require="ga4" />} />
      {q.error && <ErrorBox error={q.error} retry={() => q.refetch()} />}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
        <Kpi loading={q.isLoading} label="Active users" value={fmtCompact(live?.activeUsers ?? d?.current.activeUsersDailySum)} change={d?.change.activeUsers} hint={live ? 'deduplicated' : 'sum of daily'} accent="cyan" />
        <Kpi loading={q.isLoading} label="New users" value={fmtCompact(d?.current.newUsers)} change={d?.change.newUsers} accent="cyan" />
        <Kpi loading={q.isLoading} label="Total users" value={live ? fmtCompact(live.totalUsers) : '—'} hint={live ? 'deduplicated' : 'pick one website'} accent="cyan" />
        <Kpi loading={q.isLoading} label="Sessions" value={fmtCompact(d?.current.sessions)} change={d?.change.sessions} accent="blue" />
        <Kpi loading={q.isLoading} label="Engaged sessions" value={fmtCompact(d?.current.engagedSessions)} accent="blue" />
        <Kpi loading={q.isLoading} label="Engagement rate" value={fmtRatio(d?.current.engagementRate, 1)} hint={`avg ${fmtDuration(d?.current.avgEngagementTimeSec)}`} accent="blue" />
        <Kpi loading={q.isLoading} label="Views" value={fmtCompact(d?.current.screenPageViews)} change={d?.change.views} hint={`${fmtCompact(d?.current.eventCount)} events`} accent="gold" />
        <Kpi loading={q.isLoading} label="Key events" value={fmtCompact(d?.current.keyEvents)} change={d?.change.keyEvents} hint={d?.current.totalRevenue != null ? `revenue ${d.current.revenueCurrency} ${fmtNum(d.current.totalRevenue, 2)}` : undefined} accent="gold" />
      </div>
      {!websiteId && <div className="mt-4"><Notice>Users are counted per day and summed across websites. Select one website to see deduplicated users, comparisons and realtime data.</Notice></div>}

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Daily trend" className="xl:col-span-2" source="GA4">
          <MetricTrend data={d?.timeseries ?? []} metrics={[{ key: 'sessions', label: 'Sessions' }, { key: 'activeUsers', label: 'Active users' }, { key: 'newUsers', label: 'New users' }, { key: 'views', label: 'Views' }, { key: 'keyEvents', label: 'Key events' }]} />
        </Card>
        <Card title={<span className="flex items-center gap-2"><Radio className="h-4 w-4 text-bad" />Realtime</span>} source="Realtime API">
          {websiteId ? <Realtime websiteId={websiteId} /> : <Empty title="Select a website">Realtime reports are per GA4 property.</Empty>}
        </Card>
      </div>

      {websiteId && cmp.data && (
        <Card className="mt-5" title="Period comparisons" subtitle="Today and month-to-date are partial periods">
          <div className="grid gap-4 md:grid-cols-4">
            {Object.entries({ today_vs_yesterday: 'Today vs yesterday', last7_vs_prev7: 'Last 7 vs previous 7', last28_vs_prev28: 'Last 28 vs previous 28', month_vs_prev_month: 'Month vs previous month' }).map(([k, label]) => {
              const c = cmp.data.data[k];
              return (
                <div key={k} className="rounded-xl border border-line p-4">
                  <div className="eyebrow">{label}</div>
                  <div className="num mt-2 text-2xl font-extrabold">{fmtCompact(c?.sessions.current)}</div>
                  <div className="text-xs text-muted">sessions · prev {fmtCompact(c?.sessions.previous)}</div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                    <span>Sessions <Change value={c?.sessions.change} /></span>
                    <span>Users <Change value={c?.activeUsers.change} /></span>
                    <span>Key events <Change value={c?.keyEvents.change} /></span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Traffic acquisition" subtitle="Session default channel group" className="xl:col-span-2" pad={false}>
          <DataTable
            rows={d?.channels ?? []}
            rowKey={(r) => r.value}
            initialSort={{ key: 's', dir: 'desc' }}
            columns={[
              { key: 'c', header: 'Channel', render: (r) => <span className="font-semibold">{r.value}</span> },
              { key: 's', header: 'Sessions', align: 'right', sortValue: (r) => r.sessions, render: (r) => fmtNum(r.sessions) },
              { key: 'u', header: 'Active users', align: 'right', sortValue: (r) => r.activeUsers, render: (r) => fmtNum(r.activeUsers) },
              { key: 'e', header: 'Engagement', align: 'right', sortValue: (r) => r.engagementRate, render: (r) => fmtRatio(r.engagementRate, 1) },
              { key: 'k', header: 'Key events', align: 'right', sortValue: (r) => r.keyEvents, render: (r) => fmtNum(r.keyEvents) },
            ]}
          />
        </Card>
        <Card title="Devices" subtitle="Share of sessions">
          <ShareBar items={(d?.devices ?? []).map((x) => ({ key: x.value, label: x.value, value: x.sessions }))} />
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="Countries" actions={<Tabs value={countryMetric} onChange={setCountryMetric} items={[{ value: 'sessions', label: 'Sessions' }, { value: 'activeUsers', label: 'Users' }]} />}>
          <BarList max={12} items={(d?.countries ?? []).map((c) => ({ key: c.value, label: c.value, value: c[countryMetric], sub: c.keyEvents ? `${fmtCompact(c.keyEvents)} key events` : undefined }))} />
        </Card>
        <Card title="Top pages" pad={false}>
          <DataTable
            rows={d?.pages ?? []}
            rowKey={(r) => r.value}
            columns={[
              { key: 'p', header: 'Page path', render: (r) => <span className="block max-w-[320px] truncate" title={r.value}>{r.value}</span> },
              { key: 'v', header: 'Views', align: 'right', render: (r) => fmtNum(r.screenPageViews) },
              { key: 'u', header: 'Users', align: 'right', render: (r) => fmtNum(r.activeUsers) },
              { key: 'e', header: 'Engagement', align: 'right', render: (r) => fmtRatio(r.engagementRate, 1) },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}
