import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRaw, qs } from '../lib/api';
import { useRange } from '../lib/context';
import { useRanged, WebsitePicker } from '../lib/hooks';
import { countryName, fmtCompact, fmtNum, fmtPos, fmtRatio } from '../lib/format';
import { Card, DataTable, ErrorBox, Kpi, Notice, PageHeader, Tabs } from '../components/ui';
import { BarList, MetricTrend, ShareBar } from '../components/charts';

interface Totals { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null; freshDays: number; days: number }
interface Bd { value: string; clicks: number | null; impressions: number | null; ctr: number | null; position: number | null }
interface Summary {
  current: Totals;
  previous: Totals;
  change: { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null };
  timeseries: Array<Record<string, unknown>>;
  countries: Bd[];
  devices: Bd[];
}

export default function Seo() {
  const [websiteId, setWebsiteId] = useState('');
  const [countryMetric, setCountryMetric] = useState<'clicks' | 'impressions'>('clicks');
  const q = useRanged<Summary>('seo-summary', '/api/seo/summary', { websiteId });
  const { params } = useRange();
  const appearance = useQuery({
    queryKey: ['appearance', websiteId, params],
    queryFn: () => apiRaw<Array<{ appearance: string; clicks: number; impressions: number; ctr: number; position: number }>>(`/api/seo/search-appearance${qs({ ...params, websiteId })}`),
    enabled: Boolean(websiteId),
  });
  const d = q.data?.data;
  return (
    <div>
      <PageHeader eyebrow="Search Console" title="SEO Analytics" subtitle="Clicks, impressions, CTR and position from the official Search Analytics API." actions={<WebsitePicker value={websiteId} onChange={setWebsiteId} require="searchConsole" />} />
      {q.error && <ErrorBox error={q.error} retry={() => q.refetch()} />}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Kpi loading={q.isLoading} label="Total clicks" value={fmtNum(d?.current.clicks)} change={d?.change.clicks} accent="blue" />
        <Kpi loading={q.isLoading} label="Total impressions" value={fmtNum(d?.current.impressions)} change={d?.change.impressions} accent="blue" />
        <Kpi loading={q.isLoading} label="Average CTR" value={fmtRatio(d?.current.ctr)} change={d?.change.ctr != null ? d.change.ctr * 100 : null} changeSuffix=" pts" accent="cyan" />
        <Kpi loading={q.isLoading} label="Average position" value={fmtPos(d?.current.position)} change={d?.change.position} changeSuffix=" pos" accent="gold" hint="impression-weighted" />
      </div>
      <div className="mt-4">
        <Notice>
          Search Console data typically lags 2–3 days. The most recent days are stored as preliminary (“fresh”) and are re-fetched until final{d?.current.freshDays ? ` — ${d.current.freshDays} preliminary day(s) in this range` : ''}. “Today” may be empty.
        </Notice>
      </div>
      <div className="mt-5">
        <Card title="Daily performance" source="Search Analytics API">
          <MetricTrend
            height={300}
            data={d?.timeseries ?? []}
            metrics={[
              { key: 'clicks', label: 'Clicks' },
              { key: 'impressions', label: 'Impressions' },
              { key: 'ctr', label: 'CTR', format: (v) => fmtRatio(v) },
              { key: 'position', label: 'Avg position', format: (v) => v.toFixed(1), reversed: true },
            ]}
          />
        </Card>
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Countries" className="xl:col-span-2" actions={<Tabs value={countryMetric} onChange={setCountryMetric} items={[{ value: 'clicks', label: 'Clicks' }, { value: 'impressions', label: 'Impressions' }]} />}>
          <div className="grid gap-6 md:grid-cols-2">
            <BarList max={10} items={(d?.countries ?? []).map((c) => ({ key: c.value, label: countryName(c.value), value: c[countryMetric] }))} />
            <DataTable
              rows={(d?.countries ?? []).slice(0, 12)}
              rowKey={(r) => r.value}
              columns={[
                { key: 'c', header: 'Country', render: (r) => countryName(r.value) },
                { key: 'ctr', header: 'CTR', align: 'right', render: (r) => fmtRatio(r.ctr) },
                { key: 'p', header: 'Pos', align: 'right', render: (r) => fmtPos(r.position) },
              ]}
            />
          </div>
        </Card>
        <div className="space-y-5">
          <Card title="Devices" subtitle="Share of clicks">
            <ShareBar items={(d?.devices ?? []).map((x) => ({ key: x.value, label: x.value.toLowerCase(), value: x.clicks }))} />
            <div className="mt-4 space-y-1 text-xs">
              {(d?.devices ?? []).map((x) => (
                <div key={x.value} className="flex justify-between text-ink-2">
                  <span className="capitalize">{x.value.toLowerCase()}</span>
                  <span className="num">{fmtCompact(x.clicks)} clicks · CTR {fmtRatio(x.ctr)} · pos {fmtPos(x.position)}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Search appearance" subtitle={websiteId ? 'Live query for the selected website' : 'Select a website to load'}>
            {!websiteId ? (
              <p className="text-sm text-muted">Search appearance cannot be combined with other dimensions, so it is fetched live per property.</p>
            ) : appearance.data?.meta?.unavailable ? (
              <p className="text-sm text-muted">Unavailable: {String(appearance.data.meta.unavailable)}</p>
            ) : (
              <BarList items={(appearance.data?.data ?? []).map((a) => ({ key: a.appearance, label: a.appearance.replace(/_/g, ' ').toLowerCase(), value: a.clicks }))} />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
