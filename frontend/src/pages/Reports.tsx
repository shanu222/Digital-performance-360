import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, FileSpreadsheet, FileDown, Trash2, Download, Mail, Eye } from 'lucide-react';
import { api, del, download, post, API_BASE } from '../lib/api';
import { useRange, useToast, errMsg } from '../lib/context';
import { useAction, WebsitePicker, type AppRow } from '../lib/hooks';
import { fmtDate } from '../lib/format';
import { Button, Card, DataTable, Empty, Field, PageHeader, Select, StatusBadge, Tabs } from '../components/ui';

const TYPES = [
  { value: 'portfolio', label: 'Complete portfolio report', needs: null },
  { value: 'monthly_executive', label: 'Monthly executive report', needs: null },
  { value: 'website_seo', label: 'Individual website SEO report', needs: 'website' },
  { value: 'website_traffic', label: 'Website traffic report', needs: 'website' },
  { value: 'keywords', label: 'Keyword performance report', needs: 'website?' },
  { value: 'pages', label: 'Page performance report', needs: 'website?' },
  { value: 'android_app', label: 'Android application report', needs: 'app' },
  { value: 'play_health', label: 'Google Play health report', needs: null },
  { value: 'admob', label: 'AdMob revenue report', needs: null },
  { value: 'ai_recommendations', label: 'AI recommendations report', needs: null },
] as const;

interface FileRow { id: string; reportType: string; format: string; title: string; fileName: string; sizeBytes: number; createdAt: string; params: { range?: { start: string; end: string } } }
interface Daily { id: string; reportDate: string; generatedAt: string; emailedAt: string | null; emailError: string | null }

export default function Reports() {
  const toast = useToast();
  const { params } = useRange();
  const [type, setType] = useState<(typeof TYPES)[number]['value']>('portfolio');
  const [format, setFormat] = useState<'pdf' | 'xlsx' | 'csv'>('pdf');
  const [websiteId, setWebsiteId] = useState('');
  const [appId, setAppId] = useState('');
  const files = useQuery({ queryKey: ['report-files'], queryFn: () => api<FileRow[]>('/api/reports') });
  const daily = useQuery({ queryKey: ['daily-reports'], queryFn: () => api<Daily[]>('/api/reports/daily') });
  const apps = useQuery({ queryKey: ['apps-list'], queryFn: () => api<AppRow[]>('/api/android-apps?preset=last7') });
  const meta = TYPES.find((t) => t.value === type)!;
  const ready = (meta.needs !== 'website' || websiteId) && (meta.needs !== 'app' || appId);

  const generate = useAction(() => post<FileRow>('/api/reports/generate', { type, format, ...params, websiteId: websiteId || undefined, appId: appId || undefined }), {
    success: 'Report generated',
    invalidate: [['report-files']],
  });
  const genDaily = useAction((email: boolean) => post('/api/reports/daily/generate', { email }), { success: 'Daily report generated', invalidate: [['daily-reports']] });
  const remove = useAction((id: string) => del(`/api/reports/files/${id}`), { invalidate: [['report-files']] });
  const dl = (f: FileRow) => download(`/api/reports/files/${f.id}/download`, f.fileName).catch((e) => toast('error', errMsg(e)));

  return (
    <div>
      <PageHeader eyebrow="Reports center" title="Reports" subtitle="Professional PDF, Excel and CSV reports from stored data, using the date range selected above." />
      <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
        <Card title="Generate a report">
          <div className="grid gap-4">
            <Field label="Report type">
              <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            </Field>
            {meta.needs?.startsWith('website') && (
              <Field label={meta.needs === 'website' ? 'Website' : 'Website (optional)'}>
                <WebsitePicker value={websiteId} onChange={setWebsiteId} allowAll={meta.needs !== 'website'} />
              </Field>
            )}
            {meta.needs === 'app' && (
              <Field label="Application">
                <Select value={appId} onChange={(e) => setAppId(e.target.value)}>
                  <option value="">Select an app…</option>
                  {apps.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Format">
              <Tabs value={format} onChange={setFormat} items={[{ value: 'pdf', label: 'PDF' }, { value: 'xlsx', label: 'Excel' }, { value: 'csv', label: 'CSV' }]} />
            </Field>
            <p className="text-xs text-muted">Period: {params.preset === 'custom' ? `${params.start} → ${params.end}` : params.preset} (change it in the top bar). PDFs include an executive summary, charts, tables, dates and sources.</p>
            <Button
              variant="primary"
              disabled={!ready}
              loading={generate.isPending}
              icon={<FileDown className="h-4 w-4" />}
              onClick={() => generate.mutate(undefined, { onSuccess: (f) => void dl(f) })}
            >
              Generate & download
            </Button>
          </div>
        </Card>
        <Card title="Previous reports" pad={false}>
          <DataTable
            rows={files.data ?? []}
            loading={files.isLoading}
            rowKey={(r) => r.id}
            empty={<Empty title="No reports yet">Generated reports are stored here for later download.</Empty>}
            columns={[
              { key: 'f', header: '', width: '36px', render: (r) => (r.format === 'pdf' ? <FileText className="h-4 w-4 text-bad" /> : <FileSpreadsheet className="h-4 w-4 text-good" />) },
              { key: 't', header: 'Report', render: (r) => (<div><div className="font-semibold">{r.title}</div><div className="text-xs text-muted">{r.params.range ? `${r.params.range.start} → ${r.params.range.end}` : ''} · {r.format.toUpperCase()} · {(r.sizeBytes / 1024).toFixed(0)} KB</div></div>) },
              { key: 'c', header: 'Created', render: (r) => <span className="text-xs text-muted">{fmtDate(r.createdAt, true)}</span> },
              {
                key: 'a',
                header: '',
                render: (r) => (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => dl(r)} title="Download" />
                    <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => remove.mutate(r.id)} title="Delete" />
                  </div>
                ),
              },
            ]}
          />
        </Card>
      </div>

      <Card
        className="mt-5"
        title="Daily performance reports"
        subtitle="Generated automatically every morning by the Railway worker (schedule in Settings)"
        pad={false}
        actions={
          <>
            <Button size="sm" loading={genDaily.isPending} onClick={() => genDaily.mutate(false)}>Generate yesterday</Button>
            <Button size="sm" icon={<Mail className="h-3.5 w-3.5" />} onClick={() => genDaily.mutate(true)}>Generate & email</Button>
          </>
        }
      >
        <DataTable
          rows={daily.data ?? []}
          loading={daily.isLoading}
          rowKey={(r) => r.id}
          empty={<Empty title="No daily reports yet" />}
          columns={[
            { key: 'd', header: 'Reporting date', render: (r) => <span className="font-semibold">{fmtDate(r.reportDate)}</span> },
            { key: 'g', header: 'Generated', render: (r) => <span className="text-xs text-muted">{fmtDate(r.generatedAt, true)}</span> },
            { key: 'e', header: 'Email', render: (r) => (r.emailError ? <StatusBadge status="failed" label="Email failed" /> : r.emailedAt ? <StatusBadge status="success" label="Emailed" /> : <StatusBadge status="no_data" label="Not emailed" />) },
            {
              key: 'v',
              header: '',
              render: (r) => (
                <div className="flex justify-end">
                  <a href={`${API_BASE}/api/reports/daily/${r.reportDate}?format=html`} target="_blank" rel="noreferrer">
                    <Button size="sm" variant="ghost" icon={<Eye className="h-3.5 w-3.5" />}>View</Button>
                  </a>
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
