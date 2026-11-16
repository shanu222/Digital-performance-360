import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, TrendingUp, TrendingDown, Sparkles, Target, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { apiRaw, download, qs } from '../lib/api';
import { useRange, useToast, errMsg } from '../lib/context';
import { useRanged, WebsitePicker } from '../lib/hooks';
import { fmtNum, fmtPos, fmtRatio, shortDate } from '../lib/format';
import { Button, Card, Change, DataTable, ErrorBox, Input, Modal, Notice, PageHeader, Pager, type Column } from '../components/ui';
import { TrendChart } from '../components/charts';

interface Row {
  key: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
  prevClicks: number | null;
  prevImpressions: number | null;
  prevPosition: number | null;
  positionChange: number | null;
  clickChangePct: number | null;
  flags: string[];
}

const FILTERS = [
  { value: 'all', label: 'All', icon: null },
  { value: 'gaining_impressions', label: 'Gaining impressions', icon: TrendingUp },
  { value: 'losing_clicks', label: 'Losing clicks', icon: TrendingDown },
  { value: 'improving', label: 'Improving rank', icon: ArrowUpRight },
  { value: 'declining', label: 'Declining rank', icon: ArrowDownRight },
  { value: 'low_ctr', label: 'High impr. / low CTR', icon: Target },
  { value: 'opportunity', label: 'Traffic potential', icon: Sparkles },
];

const FLAG_LABEL: Record<string, string> = { gaining_impressions: 'Gaining', losing_clicks: 'Losing clicks', improving: 'Improving', declining: 'Declining', low_ctr: 'Low CTR', opportunity: 'Potential' };

function Trend({ kind, keyValue, websiteId, onClose }: { kind: 'keywords' | 'pages'; keyValue: string; websiteId: string; onClose: () => void }) {
  const { params } = useRange();
  const q = useQuery({ queryKey: ['trend', kind, keyValue, websiteId, params], queryFn: () => apiRaw<Array<Record<string, unknown>>>(`/api/${kind}/trend${qs({ ...params, websiteId, key: keyValue })}`) });
  const [m, setM] = useState<'clicks' | 'impressions' | 'position'>('clicks');
  return (
    <Modal open onClose={onClose} title={keyValue} wide>
      <div className="mb-3 flex gap-2">
        {(['clicks', 'impressions', 'position'] as const).map((x) => (
          <Button key={x} size="sm" variant={m === x ? 'primary' : 'secondary'} onClick={() => setM(x)}>
            {x[0].toUpperCase() + x.slice(1)}
          </Button>
        ))}
      </div>
      <TrendChart data={q.data?.data ?? []} series={[{ key: m, name: m }]} reversed={m === 'position'} yDomain={m === 'position' ? ['auto', 'auto'] : undefined} format={m === 'position' ? (v) => v.toFixed(1) : undefined} />
      {kind === 'pages' && (
        <a href={keyValue} target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs text-accent">
          Open page ↗
        </a>
      )}
    </Modal>
  );
}

function DimensionPage({ kind }: { kind: 'keywords' | 'pages' }) {
  const [sp] = useSearchParams();
  const [websiteId, setWebsiteId] = useState(sp.get('websiteId') ?? '');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'clicks', dir: 'desc' });
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const toast = useToast();
  const { params } = useRange();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(0), [websiteId, filter, debounced, params]);
  const pageSize = 50;
  const q = useRanged<Row[]>(kind, `/api/${kind}`, { websiteId, filter, search: debounced, sort: sort.key, dir: sort.dir, limit: pageSize, offset: page * pageSize });
  const total = Number(q.data?.meta?.total ?? 0);
  const label = kind === 'keywords' ? 'Keyword' : 'Page';

  const cols: Column<Row>[] = [
    {
      key: 'key',
      header: label,
      render: (r) => (
        <button className="max-w-[420px] truncate text-left font-medium hover:text-accent" title={r.key} onClick={() => setOpen(r.key)}>
          {kind === 'pages' ? r.key.replace(/^https?:\/\/[^/]+/, '') || '/' : r.key}
        </button>
      ),
    },
    { key: 'clicks', header: 'Clicks', align: 'right', render: (r) => (<div>{fmtNum(r.clicks)}<div><Change value={r.clickChangePct} /></div></div>) },
    { key: 'impressions', header: 'Impressions', align: 'right', render: (r) => fmtNum(r.impressions) },
    { key: 'ctr', header: 'CTR', align: 'right', render: (r) => fmtRatio(r.ctr) },
    { key: 'position', header: 'Avg pos', align: 'right', render: (r) => fmtPos(r.position) },
    { key: 'prev', header: 'Prev pos', align: 'right', render: (r) => <span className="text-muted">{fmtPos(r.prevPosition)}</span> },
    { key: 'position_change', header: 'Δ pos', align: 'right', render: (r) => <Change value={r.positionChange} suffix="" /> },
    {
      key: 'flags',
      header: 'Signals',
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.flags.map((f) => (
            <span key={f} className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold ${f === 'declining' || f === 'losing_clicks' ? 'bg-bad-soft text-bad' : f === 'low_ctr' ? 'bg-warn-soft text-warn' : 'bg-good-soft text-good'}`}>
              {FLAG_LABEL[f]}
            </span>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Search Console"
        title={kind === 'keywords' ? 'Keyword Intelligence' : 'Page Performance'}
        subtitle={`Every ${label.toLowerCase()} with clicks, impressions, CTR and average position versus the previous period.`}
        actions={
          <>
            <WebsitePicker value={websiteId} onChange={setWebsiteId} require="searchConsole" />
            <Button
              icon={<Download className="h-4 w-4" />}
              onClick={() => download(`/api/${kind}${qs({ ...params, websiteId, filter, search: debounced, sort: sort.key, dir: sort.dir, format: 'csv' })}`, `${kind}.csv`).catch((e) => toast('error', errMsg(e)))}
            >
              Export CSV
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${filter === f.value ? 'border-accent bg-accent-soft text-ink' : 'border-line text-ink-2 hover:bg-surface-2'}`}
          >
            {f.icon && <f.icon className="h-3.5 w-3.5" />}
            {f.label}
          </button>
        ))}
      </div>
      <Notice>Positions are averages over each period — the Search Console API does not provide exact daily rankings. Anonymised queries are excluded by Google.</Notice>
      {q.error && <div className="mt-4"><ErrorBox error={q.error} retry={() => q.refetch()} /></div>}
      <Card className="mt-4" pad={false} title={`${total.toLocaleString()} ${label.toLowerCase()}s`} subtitle={q.data?.meta?.range ? `${shortDate((q.data.meta.range as { start: string }).start)} – ${shortDate((q.data.meta.range as { end: string }).end)}` : undefined} actions={<Input placeholder={`Search ${label.toLowerCase()}s…`} value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 w-60 text-xs" />}>
        <DataTable rows={q.data?.data ?? []} loading={q.isLoading} rowKey={(r) => r.key} columns={cols} serverSort={{ ...sort, onChange: (key, dir) => setSort({ key: ['clicks', 'impressions', 'ctr', 'position', 'position_change'].includes(key) ? key : 'clicks', dir }) }} />
        {total > pageSize && <Pager page={page} pages={Math.ceil(total / pageSize)} onChange={setPage} total={total} />}
      </Card>
      {open && <Trend kind={kind} keyValue={open} websiteId={websiteId} onClose={() => setOpen(null)} />}
    </div>
  );
}

export const Keywords = () => <DimensionPage kind="keywords" />;
export const PagesPerformance = () => <DimensionPage kind="pages" />;
