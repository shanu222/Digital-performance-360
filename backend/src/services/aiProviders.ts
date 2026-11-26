/**
 * Multi-provider AI gateway: OpenAI → Gemini → OpenRouter (order configurable).
 * All three expose OpenAI-compatible Chat Completions endpoints, so one client
 * type is used with a different baseURL per provider.
 *
 * Keys come from the admin Settings page (stored AES-256-GCM encrypted in
 * application_settings) and fall back to environment variables.
 */
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { applicationSettings } from '../db/schema.js';
import { env } from '../config/env.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { AppError } from '../lib/http.js';
import { errorMessage, logger } from '../lib/logger.js';

/**
 * Provider presets. Every one exposes an OpenAI-compatible Chat Completions API,
 * so a single client type works with a different baseURL. "custom" covers any other
 * OpenAI-compatible endpoint (self-hosted, Azure proxy, etc.).
 */
export const KINDS = {
  openai: { label: 'OpenAI', baseUrl: undefined as string | undefined, keyHelp: 'platform.openai.com → API keys (sk-…)', models: ['gpt-4.1', 'gpt-4.1-mini'] },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', keyHelp: 'aistudio.google.com → Get API key', models: ['gemini-2.5-flash'] },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyHelp: 'openrouter.ai → Keys (sk-or-…)', models: ['openrouter/auto'] },
  anthropic: { label: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1/', keyHelp: 'console.anthropic.com → API keys (sk-ant-…)', models: ['claude-sonnet-5-5'] },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyHelp: 'console.groq.com → API keys (gsk_…)', models: ['llama-3.3-70b-versatile'] },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyHelp: 'platform.deepseek.com → API keys', models: ['deepseek-chat'] },
  mistral: { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyHelp: 'console.mistral.ai → API keys', models: ['mistral-large-latest'] },
  xai: { label: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', keyHelp: 'console.x.ai → API keys (xai-…)', models: ['grok-4'] },
  together: { label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', keyHelp: 'api.together.ai → Settings → API keys', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'] },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: undefined as string | undefined, keyHelp: 'Any endpoint that implements /chat/completions', models: [] as string[] },
} as const;
export type Kind = keyof typeof KINDS;
const KIND_IDS = Object.keys(KINDS) as [Kind, ...Kind[]];

/** Built-in entries; they also read keys from Railway env vars and cannot be deleted (only disabled). */
export const PROVIDERS = ['openai', 'gemini', 'openrouter'] as const;
export type BuiltIn = (typeof PROVIDERS)[number];
/** Provider entry id: a built-in name or a generated id such as "gemini-k3f9a2". */
export type Provider = string;
const isBuiltIn = (id: string): id is BuiltIn => (PROVIDERS as readonly string[]).includes(id);
export const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const MAX_PROVIDERS = 20;

export const PROVIDER_LABEL: Record<BuiltIn, string> = { openai: 'OpenAI', gemini: 'Google Gemini', openrouter: 'OpenRouter' };

/* ------------------------------ configuration ------------------------------ */

const modelList = z.array(z.string().trim().min(1).max(200)).min(1, 'Add at least one model').max(20);
const httpsUrl = z.string().trim().url().refine((u) => u.startsWith('https://'), 'Base URL must start with https://');
const providerCfg = z
  .object({
    kind: z.enum(KIND_IDS),
    label: z.string().trim().min(1).max(60),
    baseUrl: httpsUrl.nullable().optional(),
    enabled: z.boolean(),
    models: modelList,
  })
  .refine((p) => p.kind !== 'custom' || Boolean(p.baseUrl), { message: 'Custom providers need a base URL', path: ['baseUrl'] });
export type ProviderCfg = z.infer<typeof providerCfg>;

export const aiConfigSchema = z
  .object({
    order: z.array(z.string().regex(PROVIDER_ID)).min(1),
    fallbackEnabled: z.boolean(),
    cacheEnabled: z.boolean(),
    cacheTtlSec: z.number().int().min(0).max(86_400),
    maxRetries: z.number().int().min(0).max(5),
    timeoutMs: z.number().int().min(5_000).max(180_000),
    logging: z.boolean(),
    providers: z.record(z.string().regex(PROVIDER_ID), providerCfg),
  })
  .refine((c) => Object.keys(c.providers).length <= MAX_PROVIDERS, { message: `At most ${MAX_PROVIDERS} providers` });
export type AiConfig = z.infer<typeof aiConfigSchema>;

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export function defaultAiConfig(): AiConfig {
  const order = list(env.AI_PROVIDER_ORDER).filter(isBuiltIn);
  const fullOrder = [...order, ...PROVIDERS.filter((p) => !order.includes(p))];
  return {
    order: fullOrder,
    fallbackEnabled: env.AI_FALLBACK_ENABLED,
    cacheEnabled: env.AI_CACHE_ENABLED,
    cacheTtlSec: env.AI_CACHE_TTL,
    maxRetries: env.AI_MAX_RETRIES,
    timeoutMs: env.AI_TIMEOUT_MS,
    logging: env.AI_LOGGING,
    providers: {
      openai: { kind: 'openai', label: 'OpenAI', enabled: true, models: [env.OPENAI_MODEL, env.OPENAI_FALLBACK_MODEL].filter(Boolean) },
      gemini: { kind: 'gemini', label: 'Google Gemini', enabled: true, models: [env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL].filter(Boolean) },
      openrouter: { kind: 'openrouter', label: 'OpenRouter', enabled: true, models: list(env.OPENROUTER_MODELS).length ? list(env.OPENROUTER_MODELS) : ['openrouter/auto'] },
    },
  };
}

/**
 * Merges stored config (possibly from an older version without kind/label) over the
 * defaults, keeps built-ins present and makes `order` list every provider exactly once.
 */
function normalize(stored: Partial<AiConfig> | null | undefined): unknown {
  const def = defaultAiConfig();
  const providers: Record<string, unknown> = {};
  const storedProviders = (stored?.providers ?? {}) as Record<string, Partial<ProviderCfg>>;
  for (const id of new Set([...Object.keys(def.providers), ...Object.keys(storedProviders)])) {
    const base = def.providers[id];
    const merged = { ...(base ?? {}), ...(storedProviders[id] ?? {}) };
    if (isBuiltIn(id)) merged.kind = id; // a built-in never changes type
    providers[id] = merged;
  }
  const ids = Object.keys(providers);
  const order = [...new Set((stored?.order ?? def.order).filter((id) => ids.includes(id)))];
  for (const id of ids) if (!order.includes(id)) order.push(id);
  return { ...def, ...(stored ?? {}), providers, order };
}

const ENV_KEY: Record<BuiltIn, () => string> = {
  openai: () => env.OPENAI_API_KEY,
  gemini: () => env.GEMINI_API_KEY,
  openrouter: () => env.OPENROUTER_API_KEY,
};

export type KeyStatus = 'ok' | 'invalid_key' | 'quota_exceeded' | 'rate_limited' | 'model_unavailable' | 'error' | 'not_configured' | 'untested';
export interface ProviderStatus {
  status: KeyStatus;
  message: string | null;
  checkedAt: string | null;
  lastSuccessAt: string | null;
  lastModel?: string | null;
  /** provider-reported usage/limits when an API exposes them (OpenRouter) */
  usage?: Record<string, unknown> | null;
}

async function readSetting<T>(key: string): Promise<T | null> {
  const [row] = await db.select().from(applicationSettings).where(eq(applicationSettings.key, key));
  return (row?.value as T) ?? null;
}
async function writeSetting(key: string, value: unknown) {
  await db
    .insert(applicationSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: applicationSettings.key, set: { value, updatedAt: new Date() } });
}

const cache = new Map<string, { at: number; value: OpenAI.Chat.Completions.ChatCompletion; provider: string; model: string }>();
let cfgCache: { at: number; cfg: AiConfig; keys: Partial<Record<Provider, string>> } | null = null;

/** Drops cached config/keys/responses (tests, or after a database swap). */
export function resetAiCache() {
  cfgCache = null;
  cache.clear();
}

export async function getAiConfig(): Promise<AiConfig> {
  return (await loadAll()).cfg;
}

async function loadAll() {
  if (cfgCache && Date.now() - cfgCache.at < 15_000) return cfgCache;
  const stored = await readSetting<Partial<AiConfig>>('ai_config');
  const parsed = aiConfigSchema.safeParse(normalize(stored));
  if (!parsed.success) logger.warn({ issues: parsed.error.issues.slice(0, 3) }, 'Stored AI config invalid — using defaults');
  const cfg = parsed.success ? parsed.data : defaultAiConfig();
  const enc = (await readSetting<Record<string, string>>('ai_keys')) ?? {};
  const keys: Partial<Record<Provider, string>> = {};
  for (const [p, v] of Object.entries(enc)) {
    try {
      keys[p] = decrypt(v);
    } catch {
      logger.warn({ provider: p }, 'Stored AI key could not be decrypted (TOKEN_ENCRYPTION_KEY changed?)');
    }
  }
  cfgCache = { at: Date.now(), cfg, keys };
  return cfgCache;
}

const notFound = (id: string) => new AppError(404, 'not_found', `AI provider "${id}" does not exist`);
async function requireProvider(id: string) {
  const cfg = await getAiConfig();
  if (!cfg.providers[id]) throw notFound(id);
  return cfg.providers[id];
}

/**
 * Updates global options, order and existing providers' label/models/enabled/baseUrl.
 * Providers are added and removed with addProvider/removeProvider, never here.
 */
export async function updateAiConfig(patch: unknown) {
  const cur = await getAiConfig();
  const p = (patch ?? {}) as Partial<AiConfig> & { providers?: Record<string, Partial<ProviderCfg>> };
  const providers = { ...cur.providers };
  for (const [id, v] of Object.entries(p.providers ?? {})) {
    if (!providers[id]) continue; // unknown ids are ignored, not created
    providers[id] = { ...providers[id], ...v, kind: providers[id].kind };
  }
  const next = aiConfigSchema.parse(normalize({ ...cur, ...p, providers }));
  await writeSetting('ai_config', next);
  cfgCache = null;
  return next;
}

export const addProviderSchema = z.object({
  kind: z.enum(KIND_IDS),
  label: z.string().trim().min(1).max(60).optional(),
  baseUrl: httpsUrl.optional().or(z.literal('').transform(() => undefined)),
  models: modelList.optional(),
  key: z.string().trim().min(10).max(500).optional(),
});

/** Adds another provider entry (e.g. a second Gemini key, or Groq/DeepSeek/custom). Returns its id. */
export async function addProvider(input: z.infer<typeof addProviderSchema>) {
  const cur = await getAiConfig();
  if (Object.keys(cur.providers).length >= MAX_PROVIDERS) throw new AppError(400, 'too_many_providers', `At most ${MAX_PROVIDERS} AI providers can be configured`);
  const preset = KINDS[input.kind];
  const models = input.models?.length ? input.models : [...preset.models];
  if (!models.length) throw new AppError(422, 'validation_error', 'Add at least one model name');
  if (input.kind === 'custom' && !input.baseUrl) throw new AppError(422, 'validation_error', 'Custom providers need a base URL');
  const sameKind = Object.values(cur.providers).filter((x) => x.kind === input.kind).length;
  const label = input.label || (sameKind ? `${preset.label} ${sameKind + 1}` : preset.label);
  let id = '';
  do id = `${input.kind}-${crypto.randomBytes(3).toString('hex')}`;
  while (cur.providers[id]);
  const entry: ProviderCfg = { kind: input.kind, label, enabled: true, models, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}) };
  const next = aiConfigSchema.parse({ ...cur, providers: { ...cur.providers, [id]: entry }, order: [...cur.order, id] });
  await writeSetting('ai_config', next);
  cfgCache = null;
  if (input.key) await setProviderKey(id, input.key);
  return id;
}

/** Deletes an added provider with its key and status. Built-ins can only be disabled. */
export async function removeProvider(id: string) {
  await requireProvider(id);
  if (isBuiltIn(id)) throw new AppError(400, 'built_in_provider', 'Built-in providers cannot be deleted — disable them or remove their key instead');
  const cur = await getAiConfig();
  const providers = { ...cur.providers };
  delete providers[id];
  await writeSetting('ai_config', aiConfigSchema.parse({ ...cur, providers, order: cur.order.filter((x) => x !== id) }));
  const enc = (await readSetting<Record<string, string>>('ai_keys')) ?? {};
  delete enc[id];
  await writeSetting('ai_keys', enc);
  const st = await getStatuses();
  delete st[id];
  await writeSetting('ai_status', st);
  cfgCache = null;
}

/** Key in use: dashboard key first, then (built-ins only) the environment variable. */
async function keyFor(p: Provider): Promise<{ key: string; source: 'dashboard' | 'environment' } | null> {
  const { keys } = await loadAll();
  if (keys[p]) return { key: keys[p]!, source: 'dashboard' };
  const e = isBuiltIn(p) ? ENV_KEY[p]() : '';
  return e ? { key: e, source: 'environment' } : null;
}

export async function setProviderKey(p: Provider, key: string | null) {
  await requireProvider(p);
  const enc = (await readSetting<Record<string, string>>('ai_keys')) ?? {};
  if (key) enc[p] = encrypt(key.trim());
  else delete enc[p];
  await writeSetting('ai_keys', enc);
  cfgCache = null;
  await setStatus(p, { status: 'untested', message: key ? 'Key updated — run a test' : null });
}

async function getStatuses(): Promise<Partial<Record<Provider, ProviderStatus>>> {
  return (await readSetting<Partial<Record<Provider, ProviderStatus>>>('ai_status')) ?? {};
}
async function setStatus(p: Provider, s: Partial<ProviderStatus>) {
  const all = await getStatuses();
  const prev = all[p] ?? { status: 'untested', message: null, checkedAt: null, lastSuccessAt: null };
  all[p] = { ...prev, ...s, checkedAt: new Date().toISOString(), ...(s.status === 'ok' ? { lastSuccessAt: new Date().toISOString() } : {}) };
  await writeSetting('ai_status', all);
}

const mask = (k: string) => (k.length <= 10 ? '••••' : `${k.slice(0, 6)}…${k.slice(-4)}`);

/** Public view for the Settings page — never returns full keys. */
export async function providerOverview() {
  const cfg = await getAiConfig();
  const statuses = await getStatuses();
  const out = [];
  for (const p of cfg.order) {
    const c = cfg.providers[p];
    if (!c) continue;
    const k = await keyFor(p);
    out.push({
      provider: p,
      kind: c.kind,
      label: c.label,
      builtIn: isBuiltIn(p),
      baseUrl: c.baseUrl ?? KINDS[c.kind].baseUrl ?? null,
      keyHelp: KINDS[c.kind].keyHelp,
      enabled: c.enabled,
      models: c.models,
      keySource: k?.source ?? null,
      keyPreview: k ? mask(k.key) : null,
      envKeyPresent: isBuiltIn(p) && Boolean(ENV_KEY[p]()),
      position: cfg.order.indexOf(p),
      status: k ? statuses[p] ?? { status: 'untested', message: null, checkedAt: null, lastSuccessAt: null } : { status: 'not_configured', message: null, checkedAt: null, lastSuccessAt: null },
    });
  }
  const kinds = KIND_IDS.map((id) => ({ id, label: KINDS[id].label, baseUrl: KINDS[id].baseUrl ?? null, keyHelp: KINDS[id].keyHelp, models: [...KINDS[id].models] }));
  return { config: cfg, providers: out, kinds, maxProviders: MAX_PROVIDERS };
}

export async function aiConfigured(): Promise<boolean> {
  const cfg = await getAiConfig();
  for (const p of cfg.order) if (cfg.providers[p]?.enabled && (await keyFor(p))) return true;
  return false;
}

/* ------------------------------ error classification ------------------------------ */

export function classify(err: unknown): { status: KeyStatus; message: string; retryable: boolean } {
  const e = err as { status?: number; code?: string; error?: { code?: string; type?: string; message?: string } };
  const msg = errorMessage(err);
  const code = String(e?.code ?? e?.error?.code ?? e?.error?.type ?? '');
  const st = e?.status;
  if (/insufficient_quota|quota|billing|credits|RESOURCE_EXHAUSTED|exceeded your current/i.test(code + ' ' + msg) && st !== 401)
    return { status: 'quota_exceeded', message: msg, retryable: false };
  if (st === 401 || st === 403 || /invalid.*api.?key|API key not valid|incorrect api key|unauthorized|expired/i.test(msg))
    return { status: 'invalid_key', message: msg, retryable: false };
  if (st === 429) return { status: 'rate_limited', message: msg, retryable: true };
  if (st === 404 || /model.*(not found|does not exist|not supported)|no endpoints found/i.test(msg)) return { status: 'model_unavailable', message: msg, retryable: false };
  if (st === 400) return { status: 'error', message: msg, retryable: false };
  return { status: 'error', message: msg, retryable: true };
}

/* ------------------------------ completion with fallback ------------------------------ */

type Params = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, 'model'>;


function clientFor(c: ProviderCfg, key: string, timeout: number) {
  return new OpenAI({
    apiKey: key,
    baseURL: c.baseUrl || KINDS[c.kind].baseUrl,
    timeout,
    maxRetries: 0, // retries handled here so fallback stays predictable
    defaultHeaders: c.kind === 'openrouter' ? { 'HTTP-Referer': env.FRONTEND_URL.split(',')[0], 'X-Title': 'Digital Performance 360' } : undefined,
  });
}

export interface AiResult {
  completion: OpenAI.Chat.Completions.ChatCompletion;
  provider: Provider;
  model: string;
  cached: boolean;
}

/**
 * Runs a chat completion trying each enabled provider/model in order.
 * Invalid keys and exhausted quotas are recorded so the admin sees them in Settings.
 */
export async function complete(params: Params, opts: { cacheable?: boolean } = {}): Promise<AiResult> {
  const { cfg } = await loadAll();
  const cacheKey = opts.cacheable && cfg.cacheEnabled ? crypto.createHash('sha256').update(JSON.stringify(params)).digest('hex') : null;
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < cfg.cacheTtlSec * 1000) return { completion: hit.value, provider: hit.provider as Provider, model: hit.model, cached: true };
  }

  const attempts: string[] = [];
  let triedProvider = false;
  for (const p of cfg.order) {
    const pc = cfg.providers[p];
    if (!pc?.enabled) continue;
    const k = await keyFor(p);
    if (!k) continue;
    // without fallback only the first usable provider (enabled + key) is used
    if (triedProvider && !cfg.fallbackEnabled) break;
    triedProvider = true;
    const client = clientFor(pc, k.key, cfg.timeoutMs);
    const models = cfg.fallbackEnabled ? pc.models : pc.models.slice(0, 1);
    let keyBroken = false;
    for (const model of models) {
      if (keyBroken) break;
      for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
        const started = Date.now();
        try {
          const completion = await client.chat.completions.create({ ...params, model });
          if (cfg.logging) {
            logger.info({ provider: p, model, ms: Date.now() - started, tokens: completion.usage?.total_tokens }, 'AI completion');
          }
          await setStatus(p, { status: 'ok', message: null, lastModel: model }).catch(() => undefined);
          if (cacheKey) cache.set(cacheKey, { at: Date.now(), value: completion, provider: p, model });
          return { completion, provider: p, model, cached: false };
        } catch (err) {
          const c = classify(err);
          attempts.push(`${p}/${model}: ${c.status} — ${c.message.slice(0, 160)}`);
          if (cfg.logging) logger.warn({ provider: p, model, status: c.status, attempt }, 'AI call failed');
          if (c.status === 'invalid_key' || c.status === 'quota_exceeded') {
            await setStatus(p, { status: c.status, message: c.message.slice(0, 500) }).catch(() => undefined);
            keyBroken = true; // other models on the same key will fail too
            break;
          }
          if (!c.retryable || attempt === cfg.maxRetries) break;
          await new Promise((r) => setTimeout(r, Math.min(8000, 800 * 2 ** attempt)));
        }
      }
    }
  }
  if (!attempts.length) {
    throw Object.assign(new AppError(409, 'ai_not_configured', 'No AI provider key is configured. Add one in Settings → AI providers.'), { nonRetryable: true });
  }
  throw Object.assign(new AppError(502, 'ai_unavailable', `All AI providers failed: ${attempts.join(' | ')}`), { nonRetryable: true });
}

/* ------------------------------ key test ------------------------------ */

/** Live check of one provider's key: validity, quota and (OpenRouter) credit limits. */
export async function testProvider(p: Provider): Promise<ProviderStatus> {
  const pc = await requireProvider(p);
  const cfg = await getAiConfig();
  const k = await keyFor(p);
  if (!k) {
    await setStatus(p, { status: 'not_configured', message: 'No key set' });
    return (await getStatuses())[p]!;
  }
  let usage: Record<string, unknown> | null = null;
  if (pc.kind === 'openrouter') {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${k.key}` } });
      if (r.status === 401 || r.status === 403) {
        await setStatus(p, { status: 'invalid_key', message: `OpenRouter rejected the key (HTTP ${r.status})`, usage: null });
        return (await getStatuses())[p]!;
      }
      const body = (await r.json().catch(() => ({}))) as { data?: Record<string, unknown> };
      usage = body.data ?? null;
      const remaining = usage?.limit_remaining as number | null | undefined;
      if (remaining != null && remaining <= 0) {
        await setStatus(p, { status: 'quota_exceeded', message: 'OpenRouter credit limit reached for this key', usage });
        return (await getStatuses())[p]!;
      }
    } catch (err) {
      usage = { error: errorMessage(err) };
    }
  }
  const model = pc.models[0];
  try {
    const client = clientFor(pc, k.key, Math.min(cfg.timeoutMs, 30_000));
    await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with OK' }], max_tokens: 5 });
    await setStatus(p, { status: 'ok', message: `Key works with ${model}`, lastModel: model, usage });
  } catch (err) {
    const c = classify(err);
    await setStatus(p, { status: c.status, message: c.message.slice(0, 500), usage });
  }
  return (await getStatuses())[p]!;
}

/** Model ids the provider's key can use (for the Settings model picker). */
export async function listProviderModels(p: Provider): Promise<string[]> {
  const pc = await requireProvider(p);
  const k = await keyFor(p);
  if (!k) throw new AppError(400, 'no_key', 'Add a key for this provider first');
  try {
    const client = clientFor(pc, k.key, 20_000);
    const ids: string[] = [];
    for await (const m of client.models.list()) {
      ids.push(m.id.replace(/^models\//, '')); // Gemini prefixes ids with "models/"
      if (ids.length >= 1000) break;
    }
    return [...new Set(ids)].sort();
  } catch (err) {
    const c = classify(err);
    throw new AppError(502, 'models_unavailable', `Could not list models: ${c.message.slice(0, 300)}`);
  }
}
