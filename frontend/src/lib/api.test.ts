import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api, post, setCsrf, setUnauthorizedHandler, ApiError } from './api';
import { fmtNum, fmtRatio, fmtMoney, countryName } from './format';

describe('API client', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends cookies and the CSRF header on writes only', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: { x: 1 } }) });
    vi.stubGlobal('fetch', f);
    setCsrf('tok');
    await api('/api/overview');
    await post('/api/websites', { name: 'a' });
    expect(f.mock.calls[0][1].credentials).toBe('include');
    expect(f.mock.calls[0][1].headers['X-CSRF-Token']).toBeUndefined();
    expect(f.mock.calls[1][1].headers['X-CSRF-Token']).toBe('tok');
  });

  it('turns error envelopes into ApiError and signals 401s', async () => {
    const onAuth = vi.fn();
    setUnauthorizedHandler(onAuth);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ ok: false, error: { code: 'unauthenticated', message: 'Please sign in' } }) }));
    await expect(api('/api/websites')).rejects.toBeInstanceOf(ApiError);
    expect(onAuth).toHaveBeenCalled();
  });

  it('reports network failures clearly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api('/api/health')).rejects.toMatchObject({ code: 'network' });
  });
});

describe('formatting never fabricates zeros', () => {
  it('renders missing values as a dash', () => {
    expect(fmtNum(null)).toBe('—');
    expect(fmtRatio(undefined)).toBe('—');
    expect(fmtMoney(null, 'USD')).toBe('—');
    expect(fmtNum(0)).toBe('0');
  });
  it('formats currencies and countries', () => {
    expect(fmtMoney(1234.5, 'USD')).toBe('$1,234.50');
    expect(countryName('pak')).toBe('Pakistan');
    expect(countryName('US')).toBe('United States');
  });
});
