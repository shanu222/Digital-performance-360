import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Completions } from 'openai/resources/chat/completions/completions';
import { freshDb } from './db.js';
import { db } from '../src/db/client.js';
import { applicationSettings } from '../src/db/schema.js';
import { resetAiCache, classify, complete, providerOverview, setProviderKey, updateAiConfig, aiConfigured, addProvider, removeProvider, getAiConfig } from '../src/services/aiProviders.js';

const ok = (text: string) => ({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
const apiErr = (status: number, message: string, code?: string) => Object.assign(new Error(message), { status, code });

beforeEach(async () => {
  await freshDb();
  resetAiCache();
});
afterEach(() => vi.restoreAllMocks());

describe('AI provider gateway', () => {
  it('classifies invalid keys, exhausted quota and rate limits', () => {
    expect(classify(apiErr(401, 'Incorrect API key provided')).status).toBe('invalid_key');
    expect(classify(apiErr(429, 'You exceeded your current quota', 'insufficient_quota')).status).toBe('quota_exceeded');
    expect(classify(apiErr(429, 'Rate limit reached')).status).toBe('rate_limited');
    expect(classify(apiErr(404, 'The model does not exist')).status).toBe('model_unavailable');
  });

  it('stores dashboard keys encrypted and never exposes them', async () => {
    expect(await aiConfigured()).toBe(false);
    await setProviderKey('gemini', 'AQ.supersecretgeminikey123');
    const [row] = await db.select().from(applicationSettings).where((await import('drizzle-orm')).eq(applicationSettings.key, 'ai_keys'));
    expect(JSON.stringify(row.value)).not.toContain('supersecret');
    const ov = await providerOverview();
    const g = ov.providers.find((p) => p.provider === 'gemini')!;
    expect(g.keySource).toBe('dashboard');
    expect(g.keyPreview).not.toContain('supersecret');
    expect(await aiConfigured()).toBe(true);
  });

  it('falls back from a quota-exhausted provider to the next one and records the status', async () => {
    await updateAiConfig({ maxRetries: 0, cacheEnabled: false });
    await setProviderKey('openai', 'sk-test-openai-key-123');
    await setProviderKey('gemini', 'AQ.test-gemini-key-123');
    const calls: string[] = [];
    vi.spyOn(Completions.prototype, 'create').mockImplementation(function (this: { _client: { baseURL: string } }, body: { model: string }) {
      const base = this._client.baseURL;
      calls.push(`${base.includes('generativelanguage') ? 'gemini' : 'openai'}:${body.model}`);
      if (!base.includes('generativelanguage')) return Promise.reject(apiErr(429, 'You exceeded your current quota', 'insufficient_quota')) as never;
      return Promise.resolve(ok('{"recommendations":[]}')) as never;
    } as never);
    const r = await complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.provider).toBe('gemini');
    // quota error on the key → skip the OpenAI fallback model, go straight to Gemini
    expect(calls).toEqual(['openai:gpt-4.1', 'gemini:gemini-2.5-flash']);
    const ov = await providerOverview();
    expect(ov.providers.find((p) => p.provider === 'openai')!.status.status).toBe('quota_exceeded');
    expect(ov.providers.find((p) => p.provider === 'gemini')!.status.status).toBe('ok');
  });

  it('tries the fallback model when a model is unavailable', async () => {
    await updateAiConfig({ maxRetries: 0, cacheEnabled: false, order: ['openai'] });
    await setProviderKey('openai', 'sk-test-openai-key-123');
    vi.spyOn(Completions.prototype, 'create').mockImplementation(((body: { model: string }) =>
      body.model === 'gpt-4.1' ? Promise.reject(apiErr(404, 'The model gpt-4.1 does not exist')) : Promise.resolve(ok('fine'))) as never);
    const r = await complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.model).toBe('gpt-4.1-mini');
  });

  it('serves repeated recommendation prompts from cache', async () => {
    await updateAiConfig({ maxRetries: 0, cacheEnabled: true, cacheTtlSec: 3600 });
    await setProviderKey('openai', 'sk-test-openai-key-123');
    const spy = vi.spyOn(Completions.prototype, 'create').mockResolvedValue(ok('cached') as never);
    const params = { messages: [{ role: 'user' as const, content: 'same' }] };
    await complete(params, { cacheable: true });
    const second = await complete(params, { cacheable: true });
    expect(second.cached).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when no key is configured', async () => {
    await expect(complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'ai_not_configured' });
  });

  it('adds extra keys/providers, uses them in order, and deletes them', async () => {
    await updateAiConfig({ maxRetries: 0, cacheEnabled: false });
    await setProviderKey('gemini', 'AQ.first-gemini-key-123');
    const second = await addProvider({ kind: 'gemini', key: 'AQ.second-gemini-key-456' });
    const groq = await addProvider({ kind: 'groq', label: 'Groq fast', models: ['llama-3.3-70b-versatile'], key: 'gsk_test_groq_key_789' });
    const ov = await providerOverview();
    expect(ov.providers.map((p) => p.provider)).toEqual(['openai', 'gemini', 'openrouter', second, groq]);
    expect(ov.providers.find((p) => p.provider === second)!.label).toBe('Google Gemini 2');
    expect(JSON.stringify(ov)).not.toContain('second-gemini-key');

    // first Gemini key is out of quota → second Gemini key, then Groq
    const seen: string[] = [];
    vi.spyOn(Completions.prototype, 'create').mockImplementation(function (this: { _client: { baseURL: string; apiKey: string } }, body: { model: string }) {
      seen.push(`${this._client.apiKey.slice(0, 9)}:${body.model}`);
      if (this._client.apiKey.includes('first')) return Promise.reject(apiErr(429, 'RESOURCE_EXHAUSTED quota')) as never;
      if (this._client.apiKey.includes('second')) return Promise.reject(apiErr(401, 'API key not valid')) as never;
      expect(this._client.baseURL).toContain('api.groq.com');
      return Promise.resolve(ok('from groq')) as never;
    } as never);
    const r = await complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.provider).toBe(groq);
    expect(seen).toEqual(['AQ.first-:gemini-2.5-flash', 'AQ.second:gemini-2.5-flash', 'gsk_test_:llama-3.3-70b-versatile']);

    // models and order are editable for added providers; unknown ids are not created
    await updateAiConfig({ order: [groq, 'gemini'], providers: { [groq]: { models: ['llama-3.1-8b-instant'] }, bogus: { models: ['x'] } } });
    const cfg = await getAiConfig();
    expect(cfg.order.slice(0, 2)).toEqual([groq, 'gemini']);
    expect(cfg.order).toHaveLength(5);
    expect(cfg.providers[groq].models).toEqual(['llama-3.1-8b-instant']);
    expect(cfg.providers.bogus).toBeUndefined();

    await removeProvider(second);
    expect((await getAiConfig()).providers[second]).toBeUndefined();
    await expect(removeProvider('gemini')).rejects.toMatchObject({ code: 'built_in_provider' });
  });

  it('requires a base URL for custom providers and loads old saved configs', async () => {
    await expect(addProvider({ kind: 'custom', models: ['my-model'] })).rejects.toMatchObject({ code: 'validation_error' });
    const id = await addProvider({ kind: 'custom', baseUrl: 'https://llm.example.com/v1', models: ['my-model'] });
    expect((await providerOverview()).providers.find((p) => p.provider === id)!.baseUrl).toBe('https://llm.example.com/v1');
    // config saved by the previous version (no kind/label) still loads
    await db.update(applicationSettings).set({ value: { order: ['gemini', 'openai', 'openrouter'], fallbackEnabled: true, cacheEnabled: false, cacheTtlSec: 60, maxRetries: 0, timeoutMs: 30000, logging: false, providers: { openai: { enabled: false, models: ['gpt-4.1'] }, gemini: { enabled: true, models: ['gemini-2.5-pro'] }, openrouter: { enabled: true, models: ['openrouter/auto'] } } } }).where((await import('drizzle-orm')).eq(applicationSettings.key, 'ai_config'));
    resetAiCache();
    const cfg = await getAiConfig();
    expect(cfg.order).toEqual(['gemini', 'openai', 'openrouter']);
    expect(cfg.providers.gemini).toMatchObject({ kind: 'gemini', label: 'Google Gemini', models: ['gemini-2.5-pro'] });
    expect(cfg.providers.openai.enabled).toBe(false);
  });
});
