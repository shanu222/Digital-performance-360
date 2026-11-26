import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { freshDb } from './db.js';
import { createApp } from '../src/app.js';
import { ensureAdminUser } from '../src/services/auth.js';
import { db } from '../src/db/client.js';
import { oauthStates } from '../src/db/schema.js';
import { decrypt } from '../src/lib/crypto.js';

const ORIGIN = 'http://localhost:5173';

describe('authentication, CSRF and permissions', () => {
  const app = () => createApp();
  beforeAll(async () => {
    await freshDb();
    await ensureAdminUser();
  });

  it('serves a public health check', async () => {
    const r = await request(app()).get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body.db).toBe('up');
  });

  it('rejects protected routes without a session', async () => {
    for (const path of ['/api/overview', '/api/websites', '/api/admob/report', '/api/integrations', '/api/settings']) {
      const r = await request(app()).get(path);
      expect(r.status, path).toBe(401);
    }
  });

  it('rejects wrong passwords with a generic message', async () => {
    const r = await request(app()).post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'admin@example.com', password: 'nope' });
    expect(r.status).toBe(401);
    expect(r.body.error.message).toBe('Incorrect email or password');
  });

  it('logs in with an http-only cookie and enforces CSRF on writes', async () => {
    const agent = request.agent(app());
    const login = await agent.post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'admin@example.com', password: 'correct horse battery staple' });
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(JSON.stringify(login.body)).not.toMatch(/dp360_session=/);
    const csrf = login.body.data.csrfToken;

    const me = await agent.get('/api/auth/me');
    expect(me.body.data.user.email).toBe('admin@example.com');

    // missing CSRF header
    const noCsrf = await agent.post('/api/websites').set('Origin', ORIGIN).send({ name: 'Site', domain: 'example.com' });
    expect(noCsrf.status).toBe(403);
    // foreign origin
    const badOrigin = await agent.post('/api/websites').set('Origin', 'https://evil.example').set('X-CSRF-Token', csrf).send({ name: 'Site', domain: 'example.com' });
    expect(badOrigin.status).toBe(403);

    const ok = await agent.post('/api/websites').set('Origin', ORIGIN).set('X-CSRF-Token', csrf).send({ name: 'My Site', domain: 'https://www.Example.com/path' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.domain).toBe('example.com');

    // empty state: website without integrations returns nulls, not zeros
    const list = await agent.get('/api/websites?preset=last28');
    expect(list.body.data[0].clicks).toBeNull();
    expect(list.body.data[0].searchConsole).toBeNull();

    const overview = await agent.get('/api/overview?preset=last7');
    expect(overview.status).toBe(200);
    expect(overview.body.data.search.clicks).toBeNull();
    expect(overview.body.data.admob).toEqual([]);

    // validation errors are 422
    const invalid = await agent.post('/api/android-apps').set('Origin', ORIGIN).set('X-CSRF-Token', csrf).send({ name: 'x', packageName: 'not a package' });
    expect(invalid.status).toBe(422);

    // Google connect returns a consent URL with read-only scopes, state and PKCE
    const connect = await agent.post('/api/google/connect').set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
    expect(connect.status).toBe(200);
    const url = new URL(connect.body.data.url);
    expect(url.hostname).toBe('accounts.google.com');
    const scope = url.searchParams.get('scope')!;
    expect(scope).toContain('webmasters.readonly');
    expect(scope).toContain('analytics.readonly');
    expect(scope).toContain('admob.readonly');
    expect(scope).not.toMatch(/gmail|drive|\/auth\/webmasters(?!\.readonly)/);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const [st] = await db.select().from(oauthStates);
    expect(st.state).toBe(url.searchParams.get('state'));
    expect(decrypt(st.codeVerifier).length).toBeGreaterThan(40);

    // callback with forged state redirects with an error and stores nothing
    const cb = await request(app()).get('/api/google/callback?code=abc&state=forged');
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain('google=error');

    const out = await agent.post('/api/auth/logout').set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
    expect(out.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('lets the admin add, edit and delete AI providers from Settings', async () => {
    const agent = request.agent(app());
    const login = await agent.post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'admin@example.com', password: 'correct horse battery staple' });
    const csrf = login.body.data.csrfToken;
    const w = (r: request.Test) => r.set('Origin', ORIGIN).set('X-CSRF-Token', csrf);

    const added = await w(agent.post('/api/settings/ai/providers')).send({ kind: 'deepseek', label: 'DeepSeek main' });
    expect(added.status).toBe(200);
    const id = added.body.data.id as string;
    expect(added.body.data.overview.providers.find((p: { provider: string }) => p.provider === id)).toMatchObject({ label: 'DeepSeek main', models: ['deepseek-chat'], keySource: null });
    expect(added.body.data.overview.kinds.length).toBeGreaterThan(5);

    const bad = await w(agent.post('/api/settings/ai/providers')).send({ kind: 'custom', baseUrl: 'http://insecure.example/v1', models: ['m'] });
    expect(bad.status).toBe(422);

    const edited = await w(agent.put('/api/settings/ai')).send({ providers: { [id]: { models: ['deepseek-reasoner', 'deepseek-chat'] } } });
    expect(edited.body.data.providers.find((p: { provider: string }) => p.provider === id).models).toEqual(['deepseek-reasoner', 'deepseek-chat']);

    expect((await w(agent.delete('/api/settings/ai/providers/openai'))).status).toBe(400);
    const gone = await w(agent.delete(`/api/settings/ai/providers/${id}`));
    expect(gone.body.data.providers.some((p: { provider: string }) => p.provider === id)).toBe(false);
    expect((await w(agent.put(`/api/settings/ai/keys/${id}`)).send({ key: 'sk-whatever-123456' })).status).toBe(404);
  });

  it('returns 404 envelope for unknown endpoints', async () => {
    const r = await request(app()).get('/api/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body.ok).toBe(false);
  });
});
