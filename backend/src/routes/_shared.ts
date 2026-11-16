import type { Request } from 'express';
import { z } from 'zod';
import { resolveRange, type Preset } from '../lib/dates.js';
import { parse } from '../lib/http.js';
import { getSettings } from '../services/settings.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const rangeQuery = z.object({
  preset: z.enum(['today', 'yesterday', 'last7', 'last28', 'last30', 'last90', 'last180', 'this_month', 'last_month', 'custom']).default('last28'),
  start: date.optional(),
  end: date.optional(),
  compareStart: date.optional(),
  compareEnd: date.optional(),
});

export async function rangeFrom(req: Request) {
  return rangeFromQuery(req.query as Record<string, unknown>);
}

export async function rangeFromQuery(query: Record<string, unknown>) {
  const q = parse(rangeQuery, query);
  const s = await getSettings();
  if (q.preset === 'custom' && (!q.start || !q.end || q.start > q.end)) {
    throw Object.assign(new Error('custom range requires start <= end'), { status: 422 });
  }
  const r = resolveRange(q.preset as Preset, s.general.timezone, { start: q.start, end: q.end });
  if (q.compareStart && q.compareEnd) r.previous = { start: q.compareStart, end: q.compareEnd };
  return { ...r, preset: q.preset, timezone: s.general.timezone };
}

export const uuid = z.string().uuid();
export const idParam = z.object({ id: uuid });
