import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, apiRaw, qs } from '../lib/api';
import { useRanged, type Money } from '../lib/hooks';
import { countryName, fmtCompact, fmtDate, fmtMoney, fmtNum, fmtPct, titleCase } from '../lib/format';
import { Card, Change, DataTable, Empty, ErrorBox, Kpi, Notice, PageHeader, Select, Tabs } from '../components/ui';
import { BarList, ColumnChart, MetricTrend } from '../components/charts';

type G = Money & { key: string; label: string };
interface Report {
  totals: Array<Money & { change: Record<string, number | null> }>;
  daily: G[];
  monthly: G[];
  apps: G[];
  countries: G[];
  formats: G[];
}
type Summary = Record<string, { range: { start: string; end: string }; totals: Money[] }>;

function useFx(from: string | undefined, to: string) {
  return useQuery({
    queryKey: ['fx', from, to],
    queryFn: () => api<{ rate: number; source: string; fetchedAt: string; rateDate: string }>(`/api/admob/fx${qs({ from, to })}`),
    enabled: Boolean(from) && from !== to && to !== 'none',
    staleTime: 3600_000,
  });
}

export default function Admob() {
  const [appId, setAppId] = useState('');
  const [convert, setConvert] = useState<'none' | 'USD' | 'PKR'>('none');
  const [rank, setRank] = useState<'earnings' | 'ecpm'>('earnings');
  const apps = useQuery({ queryKey: ['admob-apps'], queryFn: () => api<Array<{ appId: string; displayName: string | null }>>('/api/admob/apps') });
  const q = useRanged<Report>('admob', '/api/admob/report', { appId });
  const summary = useQuery({ queryKey: ['admob-summary', appId], queryFn: () => apiRaw<Summary>(`/api/admob/summary${qs({ appId })}`) });
  const d = q.data?.data;
  const t = d?.totals[0];
  const cur = t?.currency;
  const fx = useFx(cur, convert);
  const conv = (v: number | null | undefined) => (fx.data && v != null ? fmtMoney(v * fx.data.rate, convert, convert === 'PKR' ? 0 : 2) : null);
  const money = (v: number | null | undefined, c = cur ?? 'USD') => fmtMoney(v, c);

  const periodCard = (key: string, label: string) => {
    const p = summary.data?.data[key];
    const tot = p?.totals.find((x) => x.currency === cur) ?? p?.totals[0];
    return (
      <div key={key} className="card p-4">
        <div className="eyebrow">{label}</div>
        <div className="num mt-2 text-xl font-extrabold">{tot ? money(tot.earnings, tot.currency) : '—'}</div>
        {tot && conv(tot.earnings) && <div className="num text-xs text-muted">≈ {conv(tot.earnings)}</div>}
        <div className="mt-1 text-[11px] text-muted">{p ? (p.range.start === p.range.end ? fmtDate(p.range.start) : `${fmtDate(p.range.start)} – ${fmtDate(p.range.end)}`) : ''}</div>
      </div>
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow="Google AdMob"
        title="AdMob Revenue Intelligence"
        subtitle="Estimated earnings in the original reporting currency, from the AdMob Network Report."
        actions={
          <>
            <Select value={appId} onChange={(e) => setAppId(e.target.value)} aria-label="Application">
              <option value="">All applications</option>
              {apps.data?.map((a) => <option key={a.appId} value={a.appId}>{a.displayName ?? a.appId}</option>)}
            </Select>
            <Select value={convert} onChange={(e) => setConvert(e.target.value as 'none')} aria-label="Convert currency">
              <option value="none">Original currency only</option>
              <option value="USD">Also show USD</option>
              <option value="PKR">Also show PKR</option>
            </Select>
          </>
        }
      />
      {q.error && <ErrorBox error={q.error} retry={() => q.refetch()} />}
      <Notice>
        Earnings are <b>estimated</b> until finalised by Google; today’s figures are partial. Values are never summed across currencies.
        {fx.data && ` Conversion: 1 ${cur} = ${fx.data.rate.toFixed(4)} ${convert} — ${fx.data.source}, rate date ${fx.data.rateDate}, fetched ${fmtDate(fx.data.fetchedAt, true)}.`}
      </Notice>

      <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {periodCard('today', 'Today (partial)')}
        {periodCard('yesterday', 'Yesterday')}
        {periodCard('last7', 'Last 7 days')}
        {periodCard('last30', 'Last 30 days')}
        {periodCard('thisMonth', 'Current month')}
        {periodCard('previousMonth', 'Previous month')}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Kpi loading={q.isLoading} label="Est. earnings" value={t ? money(t.earnings) : '—'} change={t?.change.earnings} hint={conv(t?.earnings) ? `≈ ${conv(t?.earnings)}` : 'selected range'} accent="gold" />
        <Kpi loading={q.isLoading} label="Impressions" value={fmtCompact(t?.impressions)} change={t?.change.impressions} accent="gold" />
        <Kpi loading={q.isLoading} label="Ad requests" value={fmtCompact(t?.adRequests)} accent="blue" />
        <Kpi loading={q.isLoading} label="Matched requests" value={fmtCompact(t?.matchedRequests)} accent="blue" />
        <Kpi loading={q.isLoading} label="Match rate" value={fmtPct(t?.matchRate, 1)} hint="matched ÷ requests" accent="blue" />
        <Kpi loading={q.isLoading} label="Show rate" value={fmtPct(t?.showRate, 1)} hint="impressions ÷ matched" accent="blue" />
        <Kpi loading={q.isLoading} label="Clicks" value={fmtCompact(t?.clicks)} change={t?.change.clicks} hint={`CTR ${fmtPct(t?.ctr)}`} accent="cyan" />
        <Kpi loading={q.isLoading} label="eCPM" value={t ? money(t.ecpm) : '—'} change={t?.change.ecpm} hint="earnings ÷ impr. × 1000" accent="cyan" />
      </div>
      {(d?.totals.length ?? 0) > 1 && <div className="mt-3"><Notice tone="warn">Multiple reporting currencies found ({d!.totals.map((x) => x.currency).join(', ')}). Figures above use {cur}; tables list each currency separately.</Notice></div>}

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Daily trend" className="xl:col-span-2" subtitle={cur ? `In ${cur}` : undefined} source="Network Report">
          <MetricTrend
            data={(d?.daily ?? []).filter((x) => x.currency === cur).map((x) => ({ date: x.key, earnings: x.earnings, ecpm: x.ecpm, impressions: x.impressions }))}
            metrics={[
              { key: 'earnings', label: 'Earnings', format: (v) => money(v) },
              { key: 'ecpm', label: 'eCPM', format: (v) => money(v) },
              { key: 'impressions', label: 'Impressions' },
            ]}
          />
        </Card>
        <Card title="Monthly revenue" subtitle="Sum of daily estimated earnings · last 12 months">
          <ColumnChart data={(d?.monthly ?? []).filter((x) => x.currency === cur)} xKey="key" yKey="earnings" name="Earnings" format={(v) => fmtMoney(v, cur ?? 'USD', 0)} />
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Application-wise revenue" className="xl:col-span-2" pad={false}>
          <DataTable
            rows={d?.apps ?? []}
            loading={q.isLoading}
            rowKey={(r) => r.key + r.currency}
            initialSort={{ key: 'e', dir: 'desc' }}
            empty={<Empty title="No AdMob data for this period">Connect Google with AdMob access and select the account in Integrations.</Empty>}
            columns={[
              { key: 'a', header: 'Application', sortValue: (r) => r.label, render: (r) => (<div><div className="font-semibold">{r.label}</div><div className="font-mono text-[10.5px] text-muted">{r.key}</div></div>) },
              { key: 'e', header: 'Earnings', align: 'right', sortValue: (r) => r.earnings, render: (r) => money(r.earnings, r.currency) },
              { key: 'i', header: 'Impressions', align: 'right', sortValue: (r) => r.impressions, render: (r) => fmtNum(r.impressions) },
              { key: 'c', header: 'Clicks', align: 'right', sortValue: (r) => r.clicks, render: (r) => fmtNum(r.clicks) },
              { key: 'p', header: 'eCPM', align: 'right', sortValue: (r) => r.ecpm, render: (r) => money(r.ecpm, r.currency) },
              { key: 'm', header: 'Match rate', align: 'right', sortValue: (r) => r.matchRate, render: (r) => fmtPct(r.matchRate, 1) },
            ]}
          />
        </Card>
        <Card title="App comparison" actions={<Tabs value={rank} onChange={setRank} items={[{ value: 'earnings', label: 'Earnings' }, { value: 'ecpm', label: 'eCPM' }]} />}>
          <BarList format={(v) => money(v)} items={(d?.apps ?? []).filter((a) => a.currency === cur).map((a) => ({ key: a.key, label: a.label, value: a[rank] }))} />
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="Country-wise revenue" pad={false}>
          <DataTable
            rows={d?.countries ?? []}
            rowKey={(r) => r.key + r.currency}
            initialSort={{ key: 'e', dir: 'desc' }}
            columns={[
              { key: 'c', header: 'Country', sortValue: (r) => countryName(r.key), render: (r) => countryName(r.key) },
              { key: 'e', header: 'Earnings', align: 'right', sortValue: (r) => r.earnings, render: (r) => money(r.earnings, r.currency) },
              { key: 'i', header: 'Impressions', align: 'right', sortValue: (r) => r.impressions, render: (r) => fmtNum(r.impressions) },
              { key: 'k', header: 'Clicks', align: 'right', sortValue: (r) => r.clicks, render: (r) => fmtNum(r.clicks) },
              { key: 'p', header: 'eCPM', align: 'right', sortValue: (r) => r.ecpm, render: (r) => money(r.ecpm, r.currency) },
            ]}
          />
        </Card>
        <Card title="Ad format performance" pad={false}>
          <DataTable
            rows={d?.formats ?? []}
            rowKey={(r) => r.key + r.currency}
            initialSort={{ key: 'e', dir: 'desc' }}
            columns={[
              { key: 'f', header: 'Format', render: (r) => titleCase(r.key.toLowerCase()) },
              { key: 'e', header: 'Earnings', align: 'right', sortValue: (r) => r.earnings, render: (r) => money(r.earnings, r.currency) },
              { key: 'i', header: 'Impressions', align: 'right', sortValue: (r) => r.impressions, render: (r) => fmtNum(r.impressions) },
              { key: 'p', header: 'eCPM', align: 'right', sortValue: (r) => r.ecpm, render: (r) => money(r.ecpm, r.currency) },
              { key: 's', header: 'Show rate', align: 'right', sortValue: (r) => r.showRate, render: (r) => fmtPct(r.showRate, 1) },
              { key: 'm', header: 'Match rate', align: 'right', sortValue: (r) => r.matchRate, render: (r) => fmtPct(r.matchRate, 1) },
            ]}
          />
          {!!d?.formats.length && <div className="border-t border-line p-4"><BarList format={(v) => money(v)} items={d.formats.filter((f) => f.currency === cur).map((f) => ({ key: f.key, label: titleCase(f.key.toLowerCase()), value: f.earnings }))} /></div>}
        </Card>
      </div>
    </div>
  );
}
