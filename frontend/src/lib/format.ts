/** Formatting helpers. null/undefined render as an em dash — never as 0. */
export const DASH = '—';

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null || Number.isNaN(v)) return DASH;
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtCompact(v: number | null | undefined): string {
  if (v == null) return DASH;
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return fmtNum(v, a < 10 && v % 1 ? 2 : 0);
}

/** ratio 0..1 → "4.32%" */
export const fmtRatio = (v: number | null | undefined, digits = 2) => (v == null ? DASH : `${(v * 100).toFixed(digits)}%`);
/** already a percentage → "4.32%" */
export const fmtPct = (v: number | null | undefined, digits = 2) => (v == null ? DASH : `${v.toFixed(digits)}%`);
export const fmtPos = (v: number | null | undefined) => (v == null ? DASH : v.toFixed(1));

export function fmtMoney(v: number | null | undefined, currency: string, digits = 2): string {
  if (v == null) return DASH;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);
  } catch {
    return `${currency} ${fmtNum(v, digits)}`;
  }
}

export function fmtDuration(sec: number | null | undefined) {
  if (sec == null) return DASH;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

export function fmtDate(d: string | Date | null | undefined, withTime = false) {
  if (!d) return DASH;
  const date = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00`) : new Date(d);
  return date.toLocaleString('en-US', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

export function fmtAgo(d: string | Date | null | undefined) {
  if (!d) return 'never';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const shortDate = (d: string) => {
  const dt = new Date(`${d}T12:00:00`);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const regionNames = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
/** Search Console uses ISO-3166 alpha-3 (lowercase), AdMob alpha-2; GA4 returns names. */
const A3: Record<string, string> = { pak: 'PK', usa: 'US', gbr: 'GB', ind: 'IN', can: 'CA', aus: 'AU', deu: 'DE', fra: 'FR', are: 'AE', sau: 'SA', bgd: 'BD', chn: 'CN', tur: 'TR', idn: 'ID', bra: 'BR', nga: 'NG', egy: 'EG', phl: 'PH', mys: 'MY', zaf: 'ZA', nld: 'NL', esp: 'ES', ita: 'IT', jpn: 'JP', rus: 'RU', mex: 'MX', qat: 'QA', kwt: 'KW', omn: 'OM', afg: 'AF', irn: 'IR', npl: 'NP', lka: 'LK', ken: 'KE', sgp: 'SG' };
export function countryName(code: string) {
  if (!code) return DASH;
  const c = code.length === 3 ? A3[code.toLowerCase()] ?? code.toUpperCase() : code.toUpperCase();
  if (c.length === 2 && regionNames) {
    try {
      return regionNames.of(c) ?? code;
    } catch {
      return code;
    }
  }
  return code;
}

export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
