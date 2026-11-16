import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, FileSpreadsheet, FileDown, Trash2, Download, Mail, Eye, X, Send, Sparkles } from 'lucide-react';
import { api, del, download, post, API_BASE } from '../lib/api';
import { useRange, useToast, errMsg, PRESETS } from '../lib/context';
import { useAction, WebsitePicker, type AppRow } from '../lib/hooks';
import { fmtDate } from '../lib/format';
import { Button, Card, DataTable, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Select, Skeleton, StatusBadge, Tabs } from '../components/ui';
import { ReportViewer, type ReportDoc } from '../components/ReportViewer';

const TYPES = [
  { value: 'portfolio', label: 'Portfolio growth report', desc: 'Everything: action plan, website scorecard, SEO opportunities, traffic quality, apps, revenue.', needs: null },
  { value: 'monthly_executive', label: 'Monthly executive report', desc: 'Same as portfolio, titled for a monthly review (use “Last month”).', needs: null },
  { value: 'website_seo', label: 'Website growth report', desc: 'One website: scorecard, striking-distance keywords, low-CTR pages, content decay, channels.', needs: 'website' },
  { value: 'website_traffic', label: 'Website traffic report', desc: 'One website’s GA4 traffic, channels, countries and devices.', needs: 'website' },
  { value: 'keywords', label: 'Keyword performance report', desc: 'Full keyword table with position changes and signals.', needs: 'website?' },
  { value: 'pages', label: 'Page performance report', desc: 'Full page table with click changes and signals.', needs: 'website?' },
  { value: 'android_app', label: 'Android app report', desc: 'One app: DAU, crash-free users, ANR, ARPDAU, eCPM, revenue.', needs: 'app' },
  { value: 'play_health', label: 'Google Play health report', desc: 'Android vitals for all monitored apps.', needs: null },
  { value: 'admob', label: 'AdMob revenue report', desc: 'Earnings, run-rate projection, concentration, app/country/format breakdown.', needs: null },
  { value: 'ai_recommendations', label: 'AI recommendations report', desc: 'All active AI recommendations with evidence.', needs: null },
] as const;
type TypeValue = (typeof TYPES)[number]['value'];

interface FileRow {
  id: string;
  reportType: string;
  format: string;
  title: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  params: { range?: { start: string; end: string } };
}
interface Daily {
  id: string;
  reportDate: string;
  generatedAt: string;
  emailedAt: string | null;
  emailError: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Type an address and press Enter / comma; invalid addresses are refused. */
function RecipientsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const add = (raw: string) => {
    const parts = raw.split(/[,\s;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = parts.filter((p) => !EMAIL_RE.test(p));
    const good = parts.filter((p) => EMAIL_RE.test(p) && !value.includes(p));
    if (good.length) onChange([...value, ...good].slice(0, 20));
    setErr(bad.length ? `Not a valid email: ${bad.join(', ')}` : null);
    setText(bad.join(' '));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ' ', 'Tab'].includes(e.key) && text.trim()) {
      e.preventDefault();
      add(text);
    } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-surface-2 px-2 py-1.5 focus-within:border-accent">
        {value.map((r) => (
          <span key={r} className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-xs font-semibold text-ink">
            {r}
            <button onClick={() => onChange(value.filter((x) => x !== r))} aria-label={`Remove ${r}`} className="text-muted hover:text-ink">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => text.trim() && add(text)}
          placeholder={value.length ? 'Add another…' : 'name@gmail.com, press Enter'}
          className="min-w-[160px] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted"
        />
      </div>
      {err && <div className="mt-1 text-xs text-bad">{err}</div>}
    </div>
  );
}

function EmailModal({ open, onClose, defaults, onSend, sending, title }: { open: boolean; onClose: () => void; defaults: string[]; onSend: (to: string[]) => void; sending: boolean; title: string }) {
  const [to, setTo] = useState<string[]>(defaults);
  useEffect(() => {
    if (open) setTo(defaults);
  }, [open, defaults]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Send className="h-4 w-4" />} disabled={!to.length} loading={sending} onClick={() => onSend(to)}>
            Send to {to.length} recipient{to.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <Field label="Recipients" hint="Any email address (Gmail or other). Up to 20. Defaults come from Settings → Email reports.">
        <RecipientsInput value={to} onChange={setTo} />
      </Field>
      <p className="mt-3 text-xs text-muted">The report is attached and the email body contains the executive summary and top actions.</p>
    </Modal>
  );
}

export default function Reports() {
  const toast = useToast();
  const { params, range } = useRange();
  const [type, setType] = useState<TypeValue>('portfolio');
  const [format, setFormat] = useState<'pdf' | 'xlsx' | 'csv'>('pdf');
  const [websiteId, setWebsiteId] = useState('');
  const [appId, setAppId] = useState('');
  const [preview, setPreview] = useState<ReportDoc | null>(null);
  const [emailFor, setEmailFor] = useState<null | { kind: 'new' } | { kind: 'file'; file: FileRow }>(null);
  const viewerRef = useRef<HTMLDivElement>(null);

  const files = useQuery({ queryKey: ['report-files'], queryFn: () => api<FileRow[]>('/api/reports') });
  const daily = useQuery({ queryKey: ['daily-reports'], queryFn: () => api<Daily[]>('/api/reports/daily') });
  const apps = useQuery({ queryKey: ['apps-list'], queryFn: () => api<AppRow[]>('/api/android-apps?preset=last7') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<{ settings: { email: { recipients: string[] } }; emailConfigured: boolean }>('/api/settings') });
  const defaults = settings.data?.settings.email.recipients ?? [];
  const emailReady = Boolean(settings.data?.emailConfigured);

  const meta = TYPES.find((t) => t.value === type)!;
  const ready = (meta.needs !== 'website' || websiteId) && (meta.needs !== 'app' || appId);
  const body = () => ({ type, format, ...params, websiteId: websiteId || undefined, appId: appId || undefined });
  const periodLabel = range.preset === 'custom' ? `${range.start} → ${range.end}` : PRESETS.find((p) => p.value === range.preset)?.label;

  const doPreview = useAction(() => post<ReportDoc>('/api/reports/preview', body()), {});
  const generate = useAction(() => post<FileRow>('/api/reports/generate', body()), { success: 'Report generated and saved', invalidate: [['report-files']] });
  const send = useAction((to: string[]) => post<FileRow & { sentTo: string[] }>('/api/reports/send', { ...body(), recipients: to }), {
    success: (r) => `Report emailed to ${r.sentTo.join(', ')}`,
    invalidate: [['report-files']],
  });
  const sendFile = useAction(({ id, to }: { id: string; to: string[] }) => post<{ sentTo: string[] }>(`/api/reports/files/${id}/email`, { recipients: to }), {
    success: (r) => `Report emailed to ${r.sentTo.join(', ')}`,
  });
  const genDaily = useAction((email: boolean) => post('/api/reports/daily/generate', { email }), { success: 'Daily report generated', invalidate: [['daily-reports']] });
  const remove = useAction((id: string) => del(`/api/reports/files/${id}`), { invalidate: [['report-files']] });
  const dl = (f: FileRow) => download(`/api/reports/files/${f.id}/download`, f.fileName).catch((e) => toast('error', errMsg(e)));

  return (
    <div>
      <PageHeader eyebrow="Reports center" title="Reports" subtitle="Preview a structured growth report here, download it as PDF / Excel / CSV, or email it to anyone." />

      <Card title="1 · Choose a report">
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div className="grid gap-2 sm:grid-cols-2">
            {TYPES.map((t) => (
              <button
                key={t.value}
                onClick={() => {
                  setType(t.value);
                  setPreview(null);
                }}
                className={`rounded-xl border p-3 text-left transition-colors ${type === t.value ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'}`}
              >
                <div className="text-sm font-bold">{t.label}</div>
                <div className="mt-0.5 text-xs text-ink-2">{t.desc}</div>
              </button>
            ))}
          </div>
          <div className="space-y-4">
            {meta.needs?.startsWith('website') && (
              <Field label={meta.needs === 'website' ? 'Website' : 'Website (optional)'}>
                <WebsitePicker value={websiteId} onChange={setWebsiteId} allowAll={meta.needs !== 'website'} />
              </Field>
            )}
            {meta.needs === 'app' && (
              <Field label="Application">
                <Select value={appId} onChange={(e) => setAppId(e.target.value)}>
                  <option value="">Select an app…</option>
                  {apps.data?.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Period" hint="Change it with the date selector in the top bar. Compared with the previous period of equal length.">
              <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm font-semibold">{periodLabel}</div>
            </Field>
            <Field label="File format (for download / email)">
              <Tabs value={format} onChange={setFormat} items={[{ value: 'pdf', label: 'PDF' }, { value: 'xlsx', label: 'Excel' }, { value: 'csv', label: 'CSV' }]} />
            </Field>
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              <Button
                variant="primary"
                icon={<Eye className="h-4 w-4" />}
                disabled={!ready}
                loading={doPreview.isPending}
                onClick={() =>
                  doPreview.mutate(undefined, {
                    onSuccess: (d) => {
                      setPreview(d);
                      setTimeout(() => viewerRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
                    },
                  })
                }
              >
                Preview here
              </Button>
              <Button icon={<FileDown className="h-4 w-4" />} disabled={!ready} loading={generate.isPending} onClick={() => generate.mutate(undefined, { onSuccess: (f) => void dl(f) })}>
                Download {format.toUpperCase()}
              </Button>
              <Button icon={<Mail className="h-4 w-4" />} disabled={!ready || !emailReady} onClick={() => setEmailFor({ kind: 'new' })} title={emailReady ? '' : 'Email is not configured on the server'}>
                Email
              </Button>
            </div>
            {!emailReady && settings.data && <Notice tone="warn">Email delivery isn’t configured on the backend yet (EMAIL_PROVIDER / Resend key).</Notice>}
          </div>
        </div>
      </Card>

      <div ref={viewerRef} className="mt-5">
        {doPreview.isPending && <Skeleton className="h-96" />}
        {doPreview.error && <ErrorBox error={doPreview.error} />}
        {preview && !doPreview.isPending && (
          <Card
            title="2 · Report preview"
            subtitle="Exactly what the PDF / Excel contains"
            actions={
              <>
                <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} loading={generate.isPending} onClick={() => generate.mutate(undefined, { onSuccess: (f) => void dl(f) })}>
                  Download {format.toUpperCase()}
                </Button>
                <Button size="sm" icon={<Mail className="h-3.5 w-3.5" />} disabled={!emailReady} onClick={() => setEmailFor({ kind: 'new' })}>
                  Email
                </Button>
              </>
            }
          >
            <ReportViewer doc={preview} />
          </Card>
        )}
        {!preview && !doPreview.isPending && (
          <Card>
            <Empty title="Preview a report" icon={<Sparkles className="h-6 w-6" />}>
              Choose a report above and click <b>Preview here</b> to read it in the dashboard, including its action plan.
            </Empty>
          </Card>
        )}
      </div>

      <Card className="mt-5" title="Saved reports" subtitle="Every generated or emailed report is kept here" pad={false}>
        <DataTable
          rows={files.data ?? []}
          loading={files.isLoading}
          rowKey={(r) => r.id}
          empty={<Empty title="No saved reports yet" />}
          columns={[
            { key: 'f', header: '', width: '36px', render: (r) => (r.format === 'pdf' ? <FileText className="h-4 w-4 text-bad" /> : <FileSpreadsheet className="h-4 w-4 text-good" />) },
            {
              key: 't',
              header: 'Report',
              render: (r) => (
                <div>
                  <div className="font-semibold">{r.title}</div>
                  <div className="text-xs text-muted">
                    {r.params.range ? `${r.params.range.start} → ${r.params.range.end}` : ''} · {r.format.toUpperCase()} · {(r.sizeBytes / 1024).toFixed(0)} KB
                  </div>
                </div>
              ),
            },
            { key: 'c', header: 'Created', render: (r) => <span className="text-xs text-muted">{fmtDate(r.createdAt, true)}</span> },
            {
              key: 'a',
              header: '',
              render: (r) => (
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => dl(r)} title="Download" />
                  <Button size="sm" variant="ghost" icon={<Mail className="h-3.5 w-3.5" />} disabled={!emailReady} onClick={() => setEmailFor({ kind: 'file', file: r })} title="Email" />
                  <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => confirm('Delete this saved report?') && remove.mutate(r.id)} title="Delete" />
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Card
        className="mt-5"
        title="Daily performance reports"
        subtitle="Generated automatically every morning; emailed to the recipients in Settings → Email reports"
        pad={false}
        actions={
          <>
            <Button size="sm" loading={genDaily.isPending} onClick={() => genDaily.mutate(false)}>Generate yesterday</Button>
            <Button size="sm" icon={<Mail className="h-3.5 w-3.5" />} disabled={!emailReady} onClick={() => genDaily.mutate(true)}>Generate & email</Button>
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

      <EmailModal
        open={emailFor !== null}
        onClose={() => setEmailFor(null)}
        defaults={defaults}
        sending={send.isPending || sendFile.isPending}
        title={emailFor?.kind === 'file' ? `Email “${emailFor.file.title}”` : `Email ${meta.label} (${format.toUpperCase()})`}
        onSend={(to) => {
          if (emailFor?.kind === 'file') sendFile.mutate({ id: emailFor.file.id, to }, { onSuccess: () => setEmailFor(null) });
          else send.mutate(to, { onSuccess: () => setEmailFor(null) });
        }}
      />
    </div>
  );
}
