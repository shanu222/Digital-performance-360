/** All metric dates are plain YYYY-MM-DD strings (no timezone drift). */

export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(d: string, n: number): string {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthStart(d: string): string {
  return `${d.slice(0, 7)}-01`;
}

export function prevMonthRange(d: string): { start: string; end: string } {
  const end = addDays(monthStart(d), -1);
  return { start: monthStart(end), end };
}

export function toYmdParts(d: string) {
  const [year, month, day] = d.split('-').map(Number);
  return { year, month, day };
}

export type Preset =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last28'
  | 'last30'
  | 'last90'
  | 'last180'
  | 'this_month'
  | 'last_month'
  | 'custom';

export interface Range {
  start: string;
  end: string;
}

/** Resolve a preset to a concrete range plus the immediately preceding comparable range. */
export function resolveRange(
  preset: Preset,
  timeZone: string,
  custom?: { start?: string; end?: string },
  now = new Date(),
): { current: Range; previous: Range } {
  const today = todayIn(timeZone, now);
  const yesterday = addDays(today, -1);
  let current: Range;
  switch (preset) {
    case 'today':
      current = { start: today, end: today };
      break;
    case 'yesterday':
      current = { start: yesterday, end: yesterday };
      break;
    case 'last7':
      current = { start: addDays(yesterday, -6), end: yesterday };
      break;
    case 'last28':
      current = { start: addDays(yesterday, -27), end: yesterday };
      break;
    case 'last30':
      current = { start: addDays(yesterday, -29), end: yesterday };
      break;
    case 'last90':
      current = { start: addDays(yesterday, -89), end: yesterday };
      break;
    case 'last180':
      current = { start: addDays(yesterday, -179), end: yesterday };
      break;
    case 'this_month':
      current = { start: monthStart(today), end: today };
      break;
    case 'last_month':
      current = prevMonthRange(today);
      break;
    case 'custom': {
      if (!custom?.start || !custom?.end) throw new Error('custom range requires start and end');
      current = { start: custom.start, end: custom.end };
      break;
    }
  }
  if (preset === 'this_month') {
    // Compare month-to-date with the same number of days of the previous month
    const pm = prevMonthRange(today);
    const len = diffDays(current.start, current.end);
    const prevEnd = addDays(pm.start, Math.min(len, diffDays(pm.start, pm.end)));
    return { current, previous: { start: pm.start, end: prevEnd } };
  }
  if (preset === 'last_month') {
    return { current, previous: prevMonthRange(current.start) };
  }
  const len = diffDays(current.start, current.end) + 1;
  const previous = { start: addDays(current.start, -len), end: addDays(current.start, -1) };
  return { current, previous };
}

/** Percentage change; null when there is no baseline (never fabricate a %). */
export function pctChange(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current == null || previous == null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}
