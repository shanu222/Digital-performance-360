import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Save, Send, KeyRound } from 'lucide-react';
import { api, post, put } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useAuth } from '../lib/context';
import { Button, Card, Field, Input, Notice, PageHeader, Select, Skeleton, Toggle } from '../components/ui';

interface Settings {
  general: { timezone: string; displayCurrency: string; convertTo: string[] };
  schedule: { searchConsole: string; ga4: string; admob: string; playReporting: string; discovery: string; dailyReport: string; searchConsoleBackfillDays: number; ga4BackfillDays: number; admobBackfillDays: number; playBackfillDays: number; initialHistoryDays: number; concurrency: number };
  email: { enabled: boolean; recipients: string[]; daily: boolean; weekly: boolean; monthly: boolean; criticalAlerts: boolean };
  thresholds: Record<string, number>;
  ai: { enabled: boolean; dailyAnalysis: boolean };
}

const TIMEZONES = ['Asia/Karachi', 'UTC', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Riyadh', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney', 'Asia/Singapore', 'Asia/Tokyo'];

const THRESHOLDS: Array<[string, string, string]> = [
  ['trafficDeclinePct', 'Traffic decline alert', '% drop week over week'],
  ['impressionDeclinePct', 'Impression decline alert', '% drop week over week'],
  ['keywordPositionChange', 'Keyword position change', 'positions'],
  ['revenueDeclinePct', 'Revenue decline alert', '% drop week over week'],
  ['ecpmChangePct', 'eCPM change alert', '% change either way'],
  ['crashRateWarning', 'Crash rate — needs attention', '% of users'],
  ['crashRateCritical', 'Crash rate — critical', '% of users'],
  ['anrRateWarning', 'ANR rate — needs attention', '% of users'],
  ['anrRateCritical', 'ANR rate — critical', '% of users'],
  ['minClicksForAlert', 'Minimum clicks/sessions before alerting', 'baseline volume'],
];

export default function SettingsPage() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<{ settings: Settings; emailConfigured: boolean; aiConfigured: boolean }>('/api/settings') });
  const [s, setS] = useState<Settings | null>(null);
  const [recipients, setRecipients] = useState('');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  useEffect(() => {
    if (q.data) {
      setS(q.data.settings);
      setRecipients(q.data.settings.email.recipients.join(', '));
    }
  }, [q.data]);
  const save = useAction(() => put('/api/settings', { ...s!, email: { ...s!.email, recipients: recipients.split(',').map((r) => r.trim()).filter(Boolean) } }), { success: 'Settings saved — schedules reload within 5 minutes', invalidate: [['settings']] });
  const testEmail = useAction(() => post('/api/settings/test-email'), { success: 'Test email sent' });
  const changePw = useAction(() => post('/api/auth/change-password', pw), { success: 'Password changed' });
  if (!s) return <Skeleton className="h-96" />;
  const set = <K extends keyof Settings>(k: K, v: Partial<Settings[K]>) => setS({ ...s, [k]: { ...s[k], ...v } });

  return (
    <div>
      <PageHeader eyebrow="System" title="Settings" subtitle="Timezone, currency, reporting schedule, email, alert thresholds and security." actions={<Button variant="primary" icon={<Save className="h-4 w-4" />} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save settings</Button>} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="General">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Timezone" hint="Used for date ranges and schedules.">
              <Select value={s.general.timezone} onChange={(e) => set('general', { timezone: e.target.value })}>
                {[...new Set([s.general.timezone, ...TIMEZONES])].map((t) => <option key={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="Default display currency" hint="AdMob always shows the original reporting currency first.">
              <Input value={s.general.displayCurrency} maxLength={3} onChange={(e) => set('general', { displayCurrency: e.target.value.toUpperCase() })} />
            </Field>
          </div>
        </Card>

        <Card title="Synchronization schedule" subtitle="Cron expressions (minute hour day month weekday) in the selected timezone">
          <div className="grid gap-3 md:grid-cols-2">
            {([['searchConsole', 'Search Console'], ['ga4', 'GA4'], ['admob', 'AdMob'], ['playReporting', 'Play Reporting'], ['discovery', 'Property discovery'], ['dailyReport', 'Daily report + AI']] as const).map(([k, label]) => (
              <Field key={k} label={label}><Input className="font-mono" value={s.schedule[k]} onChange={(e) => set('schedule', { [k]: e.target.value })} /></Field>
            ))}
            {([['searchConsoleBackfillDays', 'SC backfill days'], ['ga4BackfillDays', 'GA4 backfill days'], ['admobBackfillDays', 'AdMob backfill days'], ['playBackfillDays', 'Play backfill days'], ['initialHistoryDays', 'Initial history (days)'], ['concurrency', 'Parallel properties']] as const).map(([k, label]) => (
              <Field key={k} label={label}><Input type="number" min={1} value={s.schedule[k]} onChange={(e) => set('schedule', { [k]: Number(e.target.value) })} /></Field>
            ))}
          </div>
        </Card>

        <Card title="Email reports">
          {!q.data?.emailConfigured && <div className="mb-4"><Notice tone="warn">Email delivery is not configured on the backend (EMAIL_PROVIDER, EMAIL_FROM, EMAIL_PROVIDER_API_KEY or SMTP_*).</Notice></div>}
          <div className="grid gap-4">
            <label className="flex items-center justify-between"><span className="text-sm font-semibold">Enable email delivery</span><Toggle checked={s.email.enabled} onChange={(v) => set('email', { enabled: v })} /></label>
            <Field label="Recipients" hint="Comma-separated."><Input value={recipients} onChange={(e) => setRecipients(e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-3">
              {([['daily', 'Daily reports'], ['weekly', 'Weekly summary (Mon)'], ['monthly', 'Monthly summary (1st)'], ['criticalAlerts', 'Critical alert emails']] as const).map(([k, label]) => (
                <label key={k} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm"><span>{label}</span><Toggle checked={s.email[k]} onChange={(v) => set('email', { [k]: v })} /></label>
              ))}
            </div>
            <div><Button icon={<Send className="h-4 w-4" />} disabled={!q.data?.emailConfigured} loading={testEmail.isPending} onClick={() => testEmail.mutate(undefined)}>Send test email</Button></div>
          </div>
        </Card>

        <Card title="AI analysis">
          {!q.data?.aiConfigured && <div className="mb-4"><Notice tone="warn">OPENAI_API_KEY is not set on the backend.</Notice></div>}
          <div className="grid gap-3">
            <label className="flex items-center justify-between text-sm"><span className="font-semibold">Enable AI features</span><Toggle checked={s.ai.enabled} onChange={(v) => set('ai', { enabled: v })} /></label>
            <label className="flex items-center justify-between text-sm"><span className="font-semibold">Run daily analysis with the morning report</span><Toggle checked={s.ai.dailyAnalysis} onChange={(v) => set('ai', { dailyAnalysis: v })} /></label>
          </div>
        </Card>

        <Card title="Alert thresholds" className="xl:col-span-2">
          <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
            {THRESHOLDS.map(([k, label, hint]) => (
              <Field key={k} label={label} hint={hint}><Input type="number" step="0.01" value={s.thresholds[k]} onChange={(e) => set('thresholds', { [k]: Number(e.target.value) })} /></Field>
            ))}
          </div>
        </Card>

        <Card title="Account & security">
          <div className="mb-4 text-sm text-ink-2">Signed in as <b>{user?.email}</b> ({user?.role}). Sessions use http-only, secure cookies; tokens are never stored in the browser.</div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Current password"><Input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
            <Field label="New password" hint="At least 12 characters."><Input type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          </div>
          <Button className="mt-4" icon={<KeyRound className="h-4 w-4" />} disabled={pw.newPassword.length < 12 || !pw.currentPassword} loading={changePw.isPending} onClick={() => changePw.mutate(undefined, { onSuccess: () => setPw({ currentPassword: '', newPassword: '' }) })}>Change password</Button>
        </Card>
      </div>
    </div>
  );
}
