import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Completions } from 'openai/resources/chat/completions/completions';
import { freshDb } from './db.js';
import { db } from '../src/db/client.js';
import { applicationSettings } from '../src/db/schema.js';
import { resetAiCache, classify, complete, providerOverview, setProviderKey, updateAiConfig, aiConfigured } from '../src/services/aiProviders.js';

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
});
