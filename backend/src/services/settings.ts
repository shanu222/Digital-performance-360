import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { applicationSettings } from '../db/schema.js';
import { env } from '../config/env.js';

export const settingsSchema = z.object({
  general: z.object({
    timezone: z.string(),
    displayCurrency: z.string().length(3),
    /** optional conversions shown alongside the original AdMob currency */
    convertTo: z.array(z.enum(['USD', 'PKR'])),
  }),
  schedule: z.object({
    /** cron expressions evaluated in general.timezone */
    searchConsole: z.string(),
    ga4: z.string(),
    admob: z.string(),
    playReporting: z.string(),
    discovery: z.string(),
    dailyReport: z.string(),
    /** days re-fetched each run to absorb reporting delays */
    searchConsoleBackfillDays: z.number().int().min(1).max(16),
    ga4BackfillDays: z.number().int().min(1).max(14),
    admobBackfillDays: z.number().int().min(1).max(14),
    playBackfillDays: z.number().int().min(1).max(14),
    /** history imported on first sync of a property */
    initialHistoryDays: z.number().int().min(7).max(480),
    concurrency: z.number().int().min(1).max(8),
  }),
  email: z.object({
    enabled: z.boolean(),
    recipients: z.array(z.string().email()),
    daily: z.boolean(),
    weekly: z.boolean(),
    monthly: z.boolean(),
    criticalAlerts: z.boolean(),
  }),
  thresholds: z.object({
    trafficDeclinePct: z.number(),
    impressionDeclinePct: z.number(),
    keywordPositionChange: z.number(),
    revenueDeclinePct: z.number(),
    ecpmChangePct: z.number(),
    /** Android vitals thresholds, % of users (Google's bad-behaviour thresholds are 1.09% crash / 0.47% ANR) */
    crashRateWarning: z.number(),
    crashRateCritical: z.number(),
    anrRateWarning: z.number(),
    anrRateCritical: z.number(),
    minClicksForAlert: z.number(),
  }),
  ai: z.object({
    enabled: z.boolean(),
    dailyAnalysis: z.boolean(),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings = (): Settings => ({
  general: { timezone: env.APP_TIMEZONE, displayCurrency: env.DEFAULT_CURRENCY, convertTo: ['USD', 'PKR'] },
  schedule: {
    searchConsole: '15 5 * * *',
    ga4: '30 5 * * *',
    admob: '45 5 * * *',
    playReporting: '0 6 * * *',
    discovery: '0 4 * * 1',
    dailyReport: '30 7 * * *',
    searchConsoleBackfillDays: 5,
    ga4BackfillDays: 3,
    admobBackfillDays: 3,
    playBackfillDays: 5,
    initialHistoryDays: 90,
    concurrency: 3,
  },
  email: {
    enabled: false,
    recipients: env.EMAIL_TO ? env.EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean) : [],
    daily: true,
    weekly: true,
    monthly: true,
    criticalAlerts: true,
  },
  thresholds: {
    trafficDeclinePct: 25,
    impressionDeclinePct: 25,
    keywordPositionChange: 5,
    revenueDeclinePct: 25,
    ecpmChangePct: 30,
    crashRateWarning: 1.09,
    crashRateCritical: 2,
    anrRateWarning: 0.47,
    anrRateCritical: 1,
    minClicksForAlert: 20,
  },
  ai: { enabled: true, dailyAnalysis: true },
});

const KEY = 'app';

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return (patch ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b, v) : v;
  }
  return out as T;
}

let cache: { value: Settings; at: number } | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const [row] = await db.select().from(applicationSettings).where(eq(applicationSettings.key, KEY));
  const merged = deepMerge(defaultSettings(), row?.value ?? {});
  const parsed = settingsSchema.safeParse(merged);
  const value = parsed.success ? parsed.data : defaultSettings();
  cache = { value, at: Date.now() };
  return value;
}

export async function updateSettings(patch: unknown): Promise<Settings> {
  const current = await getSettings();
  const next = settingsSchema.parse(deepMerge(current, patch));
  await db
    .insert(applicationSettings)
    .values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: applicationSettings.key, set: { value: next, updatedAt: new Date() } });
  cache = null;
  return next;
}

export function clearSettingsCache() {
  cache = null;
}
