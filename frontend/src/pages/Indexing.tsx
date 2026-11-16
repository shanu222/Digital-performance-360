import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScanSearch, ExternalLink } from 'lucide-react';
import { api, apiRaw, post, qs } from '../lib/api';
import { useAction, WebsitePicker } from '../lib/hooks';
import { fmtDate, titleCase } from '../lib/format';
import { Button, Card, DataTable, Empty, Input, Notice, PageHeader, StatusBadge } from '../components/ui';

interface Inspection {
  id: number;
  url: string;
  siteUrl: string;
  verdict: string | null;
  coverageState: string | null;
  robotsTxtState: string | null;
  indexingState: string | null;
  pageFetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlTime: string | null;
  crawledAs: string | null;
  mobileUsabilityVerdict: string | null;
  inspectionResultLink: string | null;
  inspectedAt: string;
}
interface Sitemap { id: number; siteUrl: string; path: string; type: string | null; isPending: boolean | null; isSitemapsIndex: boolean | null; lastSubmitted: string | null; lastDownloaded: string | null; warnings: number | null; errors: number | null; contents: Array<{ type?: string; submitted?: string; indexed?: string }> | null }

const verdictStatus = (v: string | null) => (v === 'PASS' ? 'success' : v === 'FAIL' ? 'error' : v === 'PARTIAL' || v === 'NEUTRAL' ? 'warning' : 'no_data');

export default function Indexing() {
  const [websiteId, setWebsiteId] = useState('');
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<Inspection | null>(null);
  const list = useQuery({ queryKey: ['inspections', websiteId], queryFn: () => apiRaw<Inspection[]>(`/api/indexing${qs({ websiteId })}`) });
  const maps = useQuery({ queryKey: ['sitemaps', websiteId], queryFn: () => api<Sitemap[]>(`/api/sitemaps${qs({ websiteId })}`) });
  const inspect = useAction(() => post<Inspection>('/api/indexing/inspect', { websiteId, url }), { success: 'Inspection complete', invalidate: [['inspections']] });

  return (
    <div>
      <PageHeader eyebrow="Search Console" title="Indexing Monitor" subtitle="Individual URL inspections and sitemap status." actions={<WebsitePicker value={websiteId} onChange={setWebsiteId} require="searchConsole" />} />
      <Notice>
        The URL Inspection API inspects one URL at a time (about 2,000 per property per day) — it is not a complete index of your site. For aggregated page-indexing counts, use the Pages report in Search Console itself.
      </Notice>

      <Card className="mt-5" title="Inspect a URL" subtitle="Uses the official URL Inspection API (index status as known to Google)">
        <form
          className="flex flex-col gap-3 md:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            inspect.mutate(undefined, { onSuccess: (r) => setResult(r) });
          }}
        >
          <Input type="url" required placeholder="https://example.com/page" value={url} onChange={(e) => setUrl(e.target.value)} className="flex-1" />
          <Button type="submit" variant="primary" disabled={!websiteId} loading={inspect.isPending} icon={<ScanSearch className="h-4 w-4" />}>
            {websiteId ? 'Inspect URL' : 'Select a website first'}
          </Button>
        </form>
        {result && (
          <div className="mt-5 grid gap-x-8 gap-y-3 rounded-xl border border-line bg-surface-2 p-4 text-sm md:grid-cols-2">
            <div className="flex items-center gap-2 md:col-span-2">
              <StatusBadge status={verdictStatus(result.verdict)} label={result.verdict ?? 'Unknown'} />
              <span className="truncate font-semibold">{result.url}</span>
              {result.inspectionResultLink && (
                <a href={result.inspectionResultLink} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 text-xs text-accent">
                  Open in Search Console <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            {[
              ['Coverage state', result.coverageState],
              ['Indexing permission', result.indexingState && titleCase(result.indexingState.toLowerCase())],
              ['Robots.txt', result.robotsTxtState && titleCase(result.robotsTxtState.toLowerCase())],
              ['Page fetch', result.pageFetchState && titleCase(result.pageFetchState.toLowerCase())],
              ['Google-selected canonical', result.googleCanonical],
              ['User-declared canonical', result.userCanonical],
              ['Last crawl', result.lastCrawlTime ? fmtDate(result.lastCrawlTime, true) : 'Not provided'],
              ['Crawled as', result.crawledAs],
              ['Mobile usability', result.mobileUsabilityVerdict ?? 'Not provided (retired by Google)'],
              ['Inspected', fmtDate(result.inspectedAt, true)],
            ].map(([k, v]) => (
              <div key={k as string}>
                <div className="eyebrow">{k}</div>
                <div className="mt-0.5 break-all">{v || '—'}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="mt-5" title="Inspection history" pad={false} subtitle={`${list.data?.data.length ?? 0} stored inspections`}>
        <DataTable
          rows={list.data?.data ?? []}
          loading={list.isLoading}
          rowKey={(r) => String(r.id)}
          onRowClick={(r) => setResult(r)}
          empty={<Empty title="No inspections yet">Inspect important URLs above; results are stored with a timestamp.</Empty>}
          columns={[
            { key: 'v', header: 'Verdict', render: (r) => <StatusBadge status={verdictStatus(r.verdict)} label={r.verdict ?? '—'} /> },
            { key: 'u', header: 'URL', render: (r) => <span className="block max-w-[420px] truncate" title={r.url}>{r.url}</span> },
            { key: 'c', header: 'Coverage', render: (r) => <span className="text-xs">{r.coverageState ?? '—'}</span> },
            { key: 'r', header: 'Robots', render: (r) => <span className="text-xs">{r.robotsTxtState ?? '—'}</span> },
            { key: 'l', header: 'Last crawl', render: (r) => <span className="text-xs">{fmtDate(r.lastCrawlTime)}</span> },
            { key: 'i', header: 'Inspected', render: (r) => <span className="text-xs text-muted">{fmtDate(r.inspectedAt, true)}</span> },
          ]}
        />
      </Card>

      <Card className="mt-5" title="Sitemaps" pad={false} source="Sitemaps API">
        <DataTable
          rows={maps.data ?? []}
          loading={maps.isLoading}
          rowKey={(r) => String(r.id)}
          empty={<Empty title="No sitemaps found">Submit a sitemap in Search Console; it will appear after the next sync.</Empty>}
          columns={[
            { key: 's', header: 'Status', render: (r) => <StatusBadge status={(r.errors ?? 0) > 0 ? 'error' : (r.warnings ?? 0) > 0 ? 'warning' : r.isPending ? 'pending' : 'success'} label={(r.errors ?? 0) > 0 ? 'Errors' : (r.warnings ?? 0) > 0 ? 'Warnings' : r.isPending ? 'Pending' : 'Success'} /> },
            { key: 'p', header: 'Sitemap URL', render: (r) => (<div><div className="max-w-[380px] truncate" title={r.path}>{r.path}</div><div className="text-xs text-muted">{r.siteUrl}{r.isSitemapsIndex ? ' · index' : ''}</div></div>) },
            { key: 'sub', header: 'Submitted', render: (r) => <span className="text-xs">{fmtDate(r.lastSubmitted)}</span> },
            { key: 'd', header: 'Last downloaded', render: (r) => <span className="text-xs">{fmtDate(r.lastDownloaded)}</span> },
            { key: 'w', header: 'Warnings', align: 'right', render: (r) => r.warnings ?? '—' },
            { key: 'e', header: 'Errors', align: 'right', render: (r) => r.errors ?? '—' },
            { key: 'c', header: 'Discovered URLs', align: 'right', render: (r) => (r.contents ?? []).map((c) => `${c.submitted ?? '—'} ${c.type ?? ''}`).join(', ') || '—' },
          ]}
        />
      </Card>
    </div>
  );
}
