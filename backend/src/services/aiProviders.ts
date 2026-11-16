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

export const PROVIDERS = ['openai', 'gemini', 'openrouter'] as const;
export type Provider = (typeof PROVIDERS)[number];

const BASE_URL: Record<Provider, string | undefined> = {
  openai: undefined,
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  openrouter: 'https://openrouter.ai/api/v1',
};

export const PROVIDER_LABEL: Record<Provider, string> = { openai: 'OpenAI', gemini: 'Google Gemini', openrouter: 'OpenRouter' };

/* ------------------------------ configuration ------------------------------ */

const providerCfg = z.object({ enabled: z.boolean(), models: z.array(z.string().min(1)).min(1).max(10) });
export const aiConfigSchema = z.object({
  order: z.array(z.enum(PROVIDERS)).min(1),
  fallbackEnabled: z.boolean(),
  cacheEnabled: z.boolean(),
  cacheTtlSec: z.number().int().min(0).max(86_400),
  maxRetries: z.number().int().min(0).max(5),
  timeoutMs: z.number().int().min(5_000).max(180_000),
  logging: z.boolean(),
  providers: z.object({ openai: providerCfg, gemini: providerCfg, openrouter: providerCfg }),
});
export type AiConfig = z.infer<typeof aiConfigSchema>;

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export function defaultAiConfig(): AiConfig {
  const order = list(env.AI_PROVIDER_ORDER).filter((p): p is Provider => (PROVIDERS as readonly string[]).includes(p));
  return {
    order: order.length ? order : [...PROVIDERS],
    fallbackEnabled: env.AI_FALLBACK_ENABLED,
    cacheEnabled: env.AI_CACHE_ENABLED,
    cacheTtlSec: env.AI_CACHE_TTL,
    maxRetries: env.AI_MAX_RETRIES,
    timeoutMs: env.AI_TIMEOUT_MS,
    logging: env.AI_LOGGING,
    providers: {
      openai: { enabled: true, models: [env.OPENAI_MODEL, env.OPENAI_FALLBACK_MODEL].filter(Boolean) },
      gemini: { enabled: true, models: [env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL].filter(Boolean) },
      openrouter: { enabled: true, models: list(env.OPENROUTER_MODELS).length ? list(env.OPENROUTER_MODELS) : ['openrouter/auto'] },
    },
  };
}

const ENV_KEY: Record<Provider, () => string> = {
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
  const def = defaultAiConfig();
  const merged = { ...def, ...(stored ?? {}), providers: { ...def.providers, ...(stored?.providers ?? {}) } };
  const parsed = aiConfigSchema.safeParse(merged);
  const enc = (await readSetting<Partial<Record<Provider, string>>>('ai_keys')) ?? {};
  const keys: Partial<Record<Provider, string>> = {};
  for (const p of PROVIDERS) {
    if (enc[p]) {
      try {
        keys[p] = decrypt(enc[p]!);
      } catch {
        logger.warn({ provider: p }, 'Stored AI key could not be decrypted (TOKEN_ENCRYPTION_KEY changed?)');
      }
    }
  }
  cfgCache = { at: Date.now(), cfg: parsed.success ? parsed.data : def, keys };
  return cfgCache;
}

export async function updateAiConfig(patch: unknown) {
  const cur = await getAiConfig();
  const p = (patch ?? {}) as Partial<AiConfig>;
  const next = aiConfigSchema.parse({ ...cur, ...p, providers: { ...cur.providers, ...(p.providers ?? {}) } });
  await writeSetting('ai_config', next);
  cfgCache = null;
  return next;
}

/** Key in use: dashboard key first, then environment variable. */
async function keyFor(p: Provider): Promise<{ key: string; source: 'dashboard' | 'environment' } | null> {
  const { keys } = await loadAll();
  if (keys[p]) return { key: keys[p]!, source: 'dashboard' };
  const e = ENV_KEY[p]();
  return e ? { key: e, source: 'environment' } : null;
}

export async function setProviderKey(p: Provider, key: string | null) {
  const enc = (await readSetting<Partial<Record<Provider, string>>>('ai_keys')) ?? {};
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
  for (const p of PROVIDERS) {
    const k = await keyFor(p);
    out.push({
      provider: p,
      label: PROVIDER_LABEL[p],
      enabled: cfg.providers[p].enabled,
      models: cfg.providers[p].models,
      keySource: k?.source ?? null,
      keyPreview: k ? mask(k.key) : null,
      envKeyPresent: Boolean(ENV_KEY[p]()),
      position: cfg.order.indexOf(p),
      status: k ? statuses[p] ?? { status: 'untested', message: null, checkedAt: null, lastSuccessAt: null } : { status: 'not_configured', message: null, checkedAt: null, lastSuccessAt: null },
    });
  }
  return { config: cfg, providers: out };
}

export async function aiConfigured(): Promise<boolean> {
  const cfg = await getAiConfig();
  for (const p of cfg.order) if (cfg.providers[p].enabled && (await keyFor(p))) return true;
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


function clientFor(p: Provider, key: string, timeout: number) {
  return new OpenAI({
    apiKey: key,
    baseURL: BASE_URL[p],
    timeout,
    maxRetries: 0, // retries handled here so fallback stays predictable
    defaultHeaders: p === 'openrouter' ? { 'HTTP-Referer': env.FRONTEND_URL.split(',')[0], 'X-Title': 'Digital Performance 360' } : undefined,
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
  const order = cfg.fallbackEnabled ? cfg.order : cfg.order.slice(0, 1);
  for (const p of order) {
    if (!cfg.providers[p].enabled) continue;
    const k = await keyFor(p);
    if (!k) continue;
    const client = clientFor(p, k.key, cfg.timeoutMs);
    const models = cfg.fallbackEnabled ? cfg.providers[p].models : cfg.providers[p].models.slice(0, 1);
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
  const cfg = await getAiConfig();
  const k = await keyFor(p);
  if (!k) {
    await setStatus(p, { status: 'not_configured', message: 'No key set' });
    return (await getStatuses())[p]!;
  }
  let usage: Record<string, unknown> | null = null;
  if (p === 'openrouter') {
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
  const model = cfg.providers[p].models[0];
  try {
    const client = clientFor(p, k.key, Math.min(cfg.timeoutMs, 30_000));
    await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with OK' }], max_tokens: 5 });
    await setStatus(p, { status: 'ok', message: `Key works with ${model}`, lastModel: model, usage });
  } catch (err) {
    const c = classify(err);
    await setStatus(p, { status: c.status, message: c.message.slice(0, 500), usage });
  }
  return (await getStatuses())[p]!;
}
