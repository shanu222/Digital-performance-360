import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, KeyRound, PlugZap, Trash2, Save } from 'lucide-react';
import { api, del, post, put } from '../lib/api';
import { useAction } from '../lib/hooks';
import { fmtAgo } from '../lib/format';
import { Button, Card, Field, Input, Notice, Skeleton, StatusBadge, Toggle } from './ui';

type Provider = 'openai' | 'gemini' | 'openrouter';
interface Status {
  status: string;
  message: string | null;
  checkedAt: string | null;
  lastSuccessAt: string | null;
  lastModel?: string | null;
  usage?: Record<string, unknown> | null;
}
interface ProviderRow {
  provider: Provider;
  label: string;
  enabled: boolean;
  models: string[];
  keySource: 'dashboard' | 'environment' | null;
  keyPreview: string | null;
  envKeyPresent: boolean;
  position: number;
  status: Status;
}
interface Config {
  order: Provider[];
  fallbackEnabled: boolean;
  cacheEnabled: boolean;
  cacheTtlSec: number;
  maxRetries: number;
  timeoutMs: number;
  logging: boolean;
  providers: Record<Provider, { enabled: boolean; models: string[] }>;
}
interface Overview {
  config: Config;
  providers: ProviderRow[];
}

const STATUS_LABEL: Record<string, [string, string]> = {
  ok: ['success', 'Working'],
  invalid_key: ['error', 'Invalid or expired key'],
  quota_exceeded: ['critical', 'Quota / credit limit exceeded'],
  rate_limited: ['warning', 'Rate limited'],
  model_unavailable: ['warning', 'Model unavailable'],
  error: ['error', 'Error'],
  untested: ['no_data', 'Not tested yet'],
  not_configured: ['not_configured', 'No key'],
};

const KEY_HELP: Record<Provider, string> = {
  openai: 'platform.openai.com → API keys (sk-…)',
  gemini: 'aistudio.google.com → Get API key',
  openrouter: 'openrouter.ai → Keys (sk-or-…)',
};

function ProviderCard({ row, cfg, onCfg, index, count, move }: { row: ProviderRow; cfg: Config; onCfg: (c: Config) => void; index: number; count: number; move: (dir: -1 | 1) => void }) {
  const [key, setKey] = useState('');
  const inv = [['ai-overview']];
  const saveKey = useAction(() => put<{ status: Status }>(`/api/settings/ai/keys/${row.provider}`, { key }), {
    success: (r) => `${row.label} key saved — test result: ${STATUS_LABEL[r.status.status]?.[1] ?? r.status.status}`,
    invalidate: inv,
  });
  const removeKey = useAction(() => del(`/api/settings/ai/keys/${row.provider}`), { success: 'Dashboard key removed', invalidate: inv });
  const test = useAction(() => post<Status>(`/api/settings/ai/test/${row.provider}`), {
    success: (s) => `${row.label}: ${STATUS_LABEL[s.status]?.[1] ?? s.status}`,
    invalidate: inv,
  });
  const [badge, label] = STATUS_LABEL[row.status.status] ?? ['no_data', row.status.status];
  const p = cfg.providers[row.provider];
  const usage = row.status.usage as { usage?: number; limit?: number | null; limit_remaining?: number | null; is_free_tier?: boolean } | null | undefined;

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <button className="text-muted hover:text-ink disabled:opacity-30" disabled={index === 0} onClick={() => move(-1)} aria-label="Move up"><ArrowUp className="h-3.5 w-3.5" /></button>
          <button className="text-muted hover:text-ink disabled:opacity-30" disabled={index === count - 1} onClick={() => move(1)} aria-label="Move down"><ArrowDown className="h-3.5 w-3.5" /></button>
        </div>
        <span className="num flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-xs font-bold">{index + 1}</span>
        <div className="font-bold">{row.label}</div>
        <StatusBadge status={badge} label={label} />
        <div className="ml-auto flex items-center gap-2 text-xs text-ink-2">
          Enabled
          <Toggle checked={p.enabled} onChange={(v) => onCfg({ ...cfg, providers: { ...cfg.providers, [row.provider]: { ...p, enabled: v } } })} label={`Enable ${row.label}`} />
        </div>
      </div>

      <div className="mt-3 grid gap-x-6 gap-y-1 text-xs text-ink-2 md:grid-cols-2">
        <div>
          Key: {row.keyPreview ? <span className="font-mono text-ink">{row.keyPreview}</span> : <span className="text-muted">none</span>}
          {row.keySource && <span className="ml-1 text-muted">({row.keySource === 'dashboard' ? 'set here' : 'from Railway env'})</span>}
        </div>
        <div>Last checked: {fmtAgo(row.status.checkedAt)} · last success: {fmtAgo(row.status.lastSuccessAt)}{row.status.lastModel ? ` (${row.status.lastModel})` : ''}</div>
        {usage && (usage.limit != null || usage.usage != null) && (
          <div className="md:col-span-2">
            Credits: used ${Number(usage.usage ?? 0).toFixed(4)}
            {usage.limit != null ? ` of $${Number(usage.limit).toFixed(2)} · remaining $${Number(usage.limit_remaining ?? 0).toFixed(4)}` : ' · no credit limit set'}
            {usage.is_free_tier ? ' · free tier' : ''}
          </div>
        )}
        {row.status.message && row.status.status !== 'ok' && <div className="text-bad md:col-span-2">{row.status.message}</div>}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto]">
        <Field label="Models (in order — the next one is tried if a model is unavailable)">
          <Input
            className="font-mono text-xs"
            value={p.models.join(', ')}
            onChange={(e) => onCfg({ ...cfg, providers: { ...cfg.providers, [row.provider]: { ...p, models: e.target.value.split(',').map((m) => m.trim()).filter(Boolean) } } })}
          />
        </Field>
        <div className="flex items-end">
          <Button size="sm" icon={<PlugZap className="h-3.5 w-3.5" />} loading={test.isPending} disabled={!row.keySource} onClick={() => test.mutate(undefined)}>Test key</Button>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-end">
        <div className="flex-1">
          <Field label={`${row.keySource ? 'Replace' : 'Add'} API key`} hint={KEY_HELP[row.provider]}>
            <Input type="password" autoComplete="off" placeholder="Paste new key" value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
        </div>
        <div className="flex gap-2 md:pb-6">
          <Button size="sm" variant="primary" icon={<KeyRound className="h-3.5 w-3.5" />} disabled={key.trim().length < 10} loading={saveKey.isPending} onClick={() => saveKey.mutate(undefined, { onSuccess: () => setKey('') })}>
            Save & test
          </Button>
          {row.keySource === 'dashboard' && (
            <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => confirm(`Remove the ${row.label} key saved here?${row.envKeyPresent ? ' The Railway environment key will be used instead.' : ''}`) && removeKey.mutate(undefined)}>
              Remove
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function AiProvidersCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ai-overview'], queryFn: () => api<Overview>('/api/settings/ai') });
  const [cfg, setCfg] = useState<Config | null>(null);
  useEffect(() => {
    if (q.data) setCfg(q.data.config);
  }, [q.data]);
  const save = useAction(() => put('/api/settings/ai', cfg), { success: 'AI settings saved', invalidate: [['ai-overview']] });
  const testAll = useAction(async () => {
    for (const r of q.data?.providers ?? []) if (r.keySource) await post(`/api/settings/ai/test/${r.provider}`);
  }, { success: 'All configured keys tested', invalidate: [['ai-overview']] });

  if (!q.data || !cfg) return <Card title="AI providers"><Skeleton className="h-48" /></Card>;
  const rows = cfg.order.map((p) => q.data.providers.find((r) => r.provider === p)!).filter(Boolean);
  const move = (i: number, dir: -1 | 1) => {
    const order = [...cfg.order];
    const j = i + dir;
    [order[i], order[j]] = [order[j], order[i]];
    setCfg({ ...cfg, order });
  };
  const dirty = JSON.stringify(cfg) !== JSON.stringify(q.data.config);

  return (
    <Card
      title="AI providers"
      subtitle="Requests try providers top to bottom. Keys are encrypted on the server; the full key is never shown again."
      className="xl:col-span-2"
      actions={
        <>
          <Button size="sm" loading={testAll.isPending} onClick={() => testAll.mutate(undefined)}>Test all keys</Button>
          <Button size="sm" variant="primary" icon={<Save className="h-3.5 w-3.5" />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-overview'] }) })}>
            Save AI settings
          </Button>
        </>
      }
    >
      <Notice>
        “Test key” makes a tiny real request. Providers don’t publish key expiry dates; an expired or revoked key shows as <b>Invalid or expired key</b>, and exhausted billing or credits show as <b>Quota / credit limit exceeded</b>. OpenRouter also reports used and remaining credits.
      </Notice>
      <div className="mt-4 grid gap-3">
        {rows.map((r, i) => (
          <ProviderCard key={r.provider} row={r} cfg={cfg} onCfg={setCfg} index={i} count={rows.length} move={(d) => move(i, d)} />
        ))}
      </div>
      <div className="mt-5 grid gap-4 border-t border-line pt-4 md:grid-cols-3 xl:grid-cols-6">
        <label className="flex items-center justify-between gap-2 text-sm">Fallback to next provider<Toggle checked={cfg.fallbackEnabled} onChange={(v) => setCfg({ ...cfg, fallbackEnabled: v })} /></label>
        <label className="flex items-center justify-between gap-2 text-sm">Cache responses<Toggle checked={cfg.cacheEnabled} onChange={(v) => setCfg({ ...cfg, cacheEnabled: v })} /></label>
        <label className="flex items-center justify-between gap-2 text-sm">Log AI calls<Toggle checked={cfg.logging} onChange={(v) => setCfg({ ...cfg, logging: v })} /></label>
        <Field label="Cache TTL (seconds)"><Input type="number" min={0} value={cfg.cacheTtlSec} onChange={(e) => setCfg({ ...cfg, cacheTtlSec: Number(e.target.value) })} /></Field>
        <Field label="Retries per model"><Input type="number" min={0} max={5} value={cfg.maxRetries} onChange={(e) => setCfg({ ...cfg, maxRetries: Number(e.target.value) })} /></Field>
        <Field label="Timeout (ms)"><Input type="number" min={5000} step={1000} value={cfg.timeoutMs} onChange={(e) => setCfg({ ...cfg, timeoutMs: Number(e.target.value) })} /></Field>
      </div>
    </Card>
  );
}
