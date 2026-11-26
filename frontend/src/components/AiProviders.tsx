import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, KeyRound, ListPlus, PlugZap, Plus, Save, Trash2, X } from 'lucide-react';
import { api, del, post, put } from '../lib/api';
import { useAction } from '../lib/hooks';
import { fmtAgo } from '../lib/format';
import { Button, Card, Field, Input, Notice, Select, Skeleton, StatusBadge, Toggle } from './ui';

type Provider = string;
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
  kind: string;
  label: string;
  builtIn: boolean;
  baseUrl: string | null;
  keyHelp: string;
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
  providers: Record<Provider, ProviderCfg>;
}
interface ProviderCfg {
  kind: string;
  label: string;
  baseUrl?: string | null;
  enabled: boolean;
  models: string[];
}
interface Kind {
  id: string;
  label: string;
  baseUrl: string | null;
  keyHelp: string;
  models: string[];
}
interface Overview {
  config: Config;
  providers: ProviderRow[];
  kinds: Kind[];
  maxProviders: number;
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

/** Ordered model list editor: first model is tried first, the rest are fallbacks. */
function ModelsEditor({ provider, models, onChange, canBrowse }: { provider: string; models: string[]; onChange: (m: string[]) => void; canBrowse: boolean }) {
  const [draft, setDraft] = useState('');
  const [available, setAvailable] = useState<string[] | null>(null);
  const browse = useAction(() => api<string[]>(`/api/settings/ai/providers/${provider}/models`), {
    success: (r) => `${r.length} models available — start typing to pick one`,
  });
  const add = () => {
    const names = draft.split(',').map((m) => m.trim()).filter(Boolean).filter((m) => !models.includes(m));
    if (names.length) onChange([...models, ...names].slice(0, 20));
    setDraft('');
  };
  const listId = `models-${provider}`;
  return (
    <div>
      <div className="text-xs font-semibold text-ink-2">Models (tried in this order — the next one is used if a model fails)</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {models.map((m, i) => (
          <span key={m} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 py-0.5 pl-2 pr-1 font-mono text-xs">
            <span className="num text-[10px] text-muted">{i + 1}.</span>
            {m}
            {i > 0 && (
              <button type="button" className="rounded p-0.5 text-muted hover:text-ink" title="Try earlier" aria-label={`Move ${m} earlier`} onClick={() => onChange(models.map((x, j) => (j === i - 1 ? m : j === i ? models[i - 1] : x)))}>
                <ArrowLeft className="h-3 w-3" />
              </button>
            )}
            <button type="button" className="rounded p-0.5 text-muted hover:text-bad disabled:opacity-30" disabled={models.length === 1} title={models.length === 1 ? 'At least one model is required' : 'Remove'} aria-label={`Remove ${m}`} onClick={() => onChange(models.filter((x) => x !== m))}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Input
          className="min-w-56 flex-1 font-mono text-xs"
          list={listId}
          placeholder="Add a model, e.g. gemini-2.5-pro"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          aria-label="Model name to add"
        />
        <datalist id={listId}>{(available ?? []).map((m) => <option key={m} value={m} />)}</datalist>
        <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} disabled={!draft.trim()} onClick={add}>Add model</Button>
        <Button size="sm" variant="ghost" icon={<ListPlus className="h-3.5 w-3.5" />} disabled={!canBrowse} loading={browse.isPending} title={canBrowse ? 'Load the models this key can use' : 'Add a key first'} onClick={() => browse.mutate(undefined, { onSuccess: setAvailable })}>
          Browse models
        </Button>
      </div>
    </div>
  );
}

/** Form for adding another provider entry: a second key for a service, or a new service. */
function AddProvider({ kinds, disabledReason }: { kinds: Kind[]; disabledReason: string | null }) {
  const [kind, setKind] = useState(kinds[0]?.id ?? 'openai');
  const k = kinds.find((x) => x.id === kind);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState('');
  const [key, setKey] = useState('');
  const reset = () => {
    setLabel('');
    setBaseUrl('');
    setModels('');
    setKey('');
  };
  const modelList = (models || (k?.models ?? []).join(', ')).split(',').map((m) => m.trim()).filter(Boolean);
  const add = useAction(
    () => post<{ id: string; status: Status | null }>('/api/settings/ai/providers', { kind, label: label || undefined, baseUrl: kind === 'custom' ? baseUrl : undefined, models: modelList, key: key || undefined }),
    { success: (r) => (r.status ? `Provider added — test result: ${STATUS_LABEL[r.status.status]?.[1] ?? r.status.status}` : 'Provider added — add its key to use it'), invalidate: [['ai-overview']] },
  );
  const invalid = !modelList.length || (kind === 'custom' && !/^https:\/\//.test(baseUrl)) || (key.length > 0 && key.trim().length < 10);
  return (
    <div className="mt-4 rounded-xl border border-dashed border-line-strong p-4">
      <div className="flex items-center gap-2 font-bold"><Plus className="h-4 w-4" /> Add AI provider or another key</div>
      <p className="mt-1 text-xs text-muted">Add a second key for the same service (e.g. a backup Gemini key) or a new service. It is added at the bottom of the order; move it up to try it earlier.</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Service">
          <Select value={kind} onChange={(e) => { setKind(e.target.value); setModels(''); }}>
            {kinds.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </Select>
        </Field>
        <Field label="Name (optional)"><Input placeholder={k?.label ?? ''} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} /></Field>
        <Field label="Models (comma-separated, in order)" hint={k?.models.length ? `Default: ${k.models.join(', ')}` : 'Required'}>
          <Input className="font-mono text-xs" placeholder={k?.models.join(', ') || 'model-name'} value={models} onChange={(e) => setModels(e.target.value)} />
        </Field>
        <Field label="API key" hint={k?.keyHelp}>
          <Input type="password" autoComplete="off" placeholder="Paste key (optional now)" value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        {kind === 'custom' && (
          <div className="md:col-span-2">
            <Field label="Base URL (OpenAI-compatible, https)" hint="The URL before /chat/completions, e.g. https://llm.example.com/v1">
              <Input className="font-mono text-xs" placeholder="https://…/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </Field>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} disabled={invalid || Boolean(disabledReason)} loading={add.isPending} onClick={() => add.mutate(undefined, { onSuccess: reset })}>
          {key ? 'Add & test' : 'Add provider'}
        </Button>
        {disabledReason && <span className="text-xs text-warn">{disabledReason}</span>}
      </div>
    </div>
  );
}

function ProviderCard({ row, cfg, onCfg, index, count, move, kinds, dirty }: { row: ProviderRow; cfg: Config; onCfg: (c: Config) => void; index: number; count: number; move: (dir: -1 | 1) => void; kinds: Kind[]; dirty: boolean }) {
  const [key, setKey] = useState('');
  const inv = [['ai-overview']];
  const saveKey = useAction(() => put<{ status: Status }>(`/api/settings/ai/keys/${row.provider}`, { key }), {
    success: (r) => `${row.label} key saved — test result: ${STATUS_LABEL[r.status.status]?.[1] ?? r.status.status}`,
    invalidate: inv,
  });
  const removeKey = useAction(() => del(`/api/settings/ai/keys/${row.provider}`), { success: 'Dashboard key removed', invalidate: inv });
  const removeProvider = useAction(() => del(`/api/settings/ai/providers/${row.provider}`), { success: `${row.label} deleted`, invalidate: inv });
  const test = useAction(() => post<Status>(`/api/settings/ai/test/${row.provider}`), {
    success: (s) => `${row.label}: ${STATUS_LABEL[s.status]?.[1] ?? s.status}`,
    invalidate: inv,
  });
  const [badge, label] = STATUS_LABEL[row.status.status] ?? ['no_data', row.status.status];
  const p = cfg.providers[row.provider];
  const setP = (patch: Partial<ProviderCfg>) => onCfg({ ...cfg, providers: { ...cfg.providers, [row.provider]: { ...p, ...patch } } });
  const kindLabel = kinds.find((k) => k.id === row.kind)?.label ?? row.kind;
  const usage = row.status.usage as { usage?: number; limit?: number | null; limit_remaining?: number | null; is_free_tier?: boolean } | null | undefined;

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <button className="text-muted hover:text-ink disabled:opacity-30" disabled={index === 0} onClick={() => move(-1)} aria-label="Move up"><ArrowUp className="h-3.5 w-3.5" /></button>
          <button className="text-muted hover:text-ink disabled:opacity-30" disabled={index === count - 1} onClick={() => move(1)} aria-label="Move down"><ArrowDown className="h-3.5 w-3.5" /></button>
        </div>
        <span className="num flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-xs font-bold">{index + 1}</span>
        <input
          className="min-w-0 rounded-md border border-transparent bg-transparent px-1 font-bold [field-sizing:content] hover:border-line focus:border-accent focus:outline-none"
          value={p.label}
          maxLength={60}
          onChange={(e) => setP({ label: e.target.value })}
          aria-label="Provider name"
          size={Math.max(4, p.label.length + 1)}
        />
        {p.label !== kindLabel && <span className="text-xs text-muted">{kindLabel}</span>}
        <StatusBadge status={badge} label={label} />
        <div className="ml-auto flex items-center gap-2 text-xs text-ink-2">
          Enabled
          <Toggle checked={p.enabled} onChange={(v) => setP({ enabled: v })} label={`Enable ${row.label}`} />
          {!row.builtIn && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              disabled={dirty}
              title={dirty ? 'Save or discard your changes first' : 'Delete this provider and its key'}
              loading={removeProvider.isPending}
              onClick={() => confirm(`Delete ${row.label} and its saved key?`) && removeProvider.mutate(undefined)}
            >
              Delete
            </Button>
          )}
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

      {row.kind === 'custom' && (
        <div className="mt-3">
          <Field label="Base URL (OpenAI-compatible, https)">
            <Input className="font-mono text-xs" value={p.baseUrl ?? ''} onChange={(e) => setP({ baseUrl: e.target.value })} />
          </Field>
        </div>
      )}

      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto]">
        <ModelsEditor provider={row.provider} models={p.models} onChange={(models) => setP({ models })} canBrowse={Boolean(row.keySource)} />
        <div className="flex items-start">
          <Button size="sm" icon={<PlugZap className="h-3.5 w-3.5" />} loading={test.isPending} disabled={!row.keySource || dirty} title={dirty ? 'Save your changes first — the test uses the saved first model' : undefined} onClick={() => test.mutate(undefined)}>Test key</Button>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-end">
        <div className="flex-1">
          <Field label={`${row.keySource ? 'Replace' : 'Add'} API key`} hint={row.keyHelp}>
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
  const rows = cfg.order.map((p) => q.data.providers.find((r) => r.provider === p)!).filter((r) => r && cfg.providers[r.provider]);
  const move = (i: number, dir: -1 | 1) => {
    const order = [...cfg.order];
    const j = i + dir;
    [order[i], order[j]] = [order[j], order[i]];
    setCfg({ ...cfg, order });
  };
  const dirty = JSON.stringify(cfg) !== JSON.stringify(q.data.config);
  const full = Object.keys(q.data.config.providers).length >= q.data.maxProviders;

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
          <ProviderCard key={r.provider} row={r} cfg={cfg} onCfg={setCfg} index={i} count={rows.length} move={(d) => move(i, d)} kinds={q.data.kinds} dirty={dirty} />
        ))}
      </div>
      {dirty && (
        <div className="mt-3 flex items-center gap-2">
          <Notice tone="warn">You have unsaved changes to names, models, order or options.</Notice>
          <Button size="sm" variant="ghost" onClick={() => setCfg(q.data.config)}>Discard</Button>
        </div>
      )}
      <AddProvider kinds={q.data.kinds} disabledReason={dirty ? 'Save or discard your changes first' : full ? `Limit of ${q.data.maxProviders} providers reached` : null} />
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
