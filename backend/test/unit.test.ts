import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, hashToken } from '../src/lib/crypto.js';
import { resolveRange, pctChange, addDays } from '../src/lib/dates.js';
import { toCsv, ga4Date } from '../src/lib/util.js';
import { scrub } from '../src/lib/logger.js';
import { parseNetworkReport } from '../src/services/google/admob.js';
import { classifyHealth } from '../src/services/metrics.js';
import { defaultSettings } from '../src/services/settings.js';
import { syncWindow } from '../src/services/sync/handlers.js';

describe('token encryption', () => {
  it('round-trips and uses random IVs', () => {
    const a = encrypt('1//refresh-token');
    const b = encrypt('1//refresh-token');
    expect(a).not.toEqual(b);
    expect(a).not.toContain('refresh-token');
    expect(decrypt(a)).toBe('1//refresh-token');
  });
  it('rejects tampered ciphertext', () => {
    const c = encrypt('secret');
    const parts = c.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(parts.join(':'))).toThrow();
  });
  it('hashes session tokens deterministically', () => {
    expect(hashToken('x')).toBe(hashToken('x'));
    expect(hashToken('x')).not.toBe('x');
  });
});

describe('date ranges & comparisons', () => {
  const now = new Date('2026-11-16T10:00:00Z');
  it('last7 ends yesterday and compares with the previous 7 days', () => {
    const r = resolveRange('last7', 'UTC', undefined, now);
    expect(r.current).toEqual({ start: '2026-11-09', end: '2026-11-15' });
    expect(r.previous).toEqual({ start: '2026-11-02', end: '2026-11-08' });
  });
  it('last_month compares with the month before', () => {
    const r = resolveRange('last_month', 'UTC', undefined, now);
    expect(r.current).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(r.previous).toEqual({ start: '2026-09-01', end: '2026-09-30' });
  });
  it('respects the configured time zone', () => {
    const late = new Date('2026-11-16T21:00:00Z'); // already 17th in Karachi (UTC+5)
    expect(resolveRange('today', 'Asia/Karachi', undefined, late).current.start).toBe('2026-11-17');
  });
  it('never fabricates a percentage without a baseline', () => {
    expect(pctChange(10, 0)).toBeNull();
    expect(pctChange(null, 5)).toBeNull();
    expect(pctChange(0, 0)).toBe(0);
    expect(pctChange(150, 100)).toBe(50);
  });
  it('computes incremental sync windows with backfill', () => {
    expect(syncWindow(null, '2026-11-16', 3, 90)).toEqual({ start: addDays('2026-11-16', -89), end: '2026-11-16' });
    expect(syncWindow('2026-11-14', '2026-11-16', 3, 90)).toEqual({ start: '2026-11-11', end: '2026-11-16' });
  });
});

describe('helpers', () => {
  it('escapes CSV and neutralises formulas', () => {
    expect(toCsv(['a'], [['=HYPERLINK("x")'], ['x,y']])).toBe('a\n"\'=HYPERLINK(""x"")"\n"x,y"');
  });
  it('converts GA4 dates', () => expect(ga4Date('20261115')).toBe('2026-11-15'));
  it('scrubs tokens from messages', () => {
    expect(scrub('Bearer ya29.abc-def failed')).not.toContain('ya29.abc');
  });
});

describe('AdMob report parsing', () => {
  it('reads the streamed [header, rows..., footer] array', () => {
    const r = parseNetworkReport([
      { header: { localizationSettings: { currencyCode: 'USD' } } },
      { row: { dimensionValues: { DATE: { value: '20261115' } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: '1500000' } } } },
      { footer: { matchingRowCount: '1' } },
    ]);
    expect(r.currency).toBe('USD');
    expect(r.rows).toHaveLength(1);
  });
});

describe('app health classification', () => {
  const t = defaultSettings().thresholds;
  it('classifies with configurable thresholds', () => {
    expect(classifyHealth(null, null, t)).toBe('no_data');
    expect(classifyHealth(0.3, 0.1, t)).toBe('healthy');
    expect(classifyHealth(1.2, 0.1, t)).toBe('needs_attention');
    expect(classifyHealth(0.5, 1.5, t)).toBe('critical');
    expect(classifyHealth(1.2, 0.1, { ...t, crashRateWarning: 1.5 })).toBe('healthy');
  });
});

import { expectedCtr, trendOf } from '../src/services/reports/growth.js';
describe('growth formulas', () => {
  it('interpolates the CTR benchmark by position', () => {
    expect(expectedCtr(1)).toBeCloseTo(0.284);
    expect(expectedCtr(3)).toBeCloseTo(0.11);
    expect(expectedCtr(3.5)!).toBeCloseTo((0.11 + 0.08) / 2);
    expect(expectedCtr(15)).toBe(0.012);
    expect(expectedCtr(null)).toBeNull();
  });
  it('classifies growth status with ±5% bands', () => {
    expect(trendOf(12, 100)).toBe('growing');
    expect(trendOf(-8, 100)).toBe('declining');
    expect(trendOf(2, 100)).toBe('stable');
    expect(trendOf(null, null)).toBe('no_data');
  });
});
