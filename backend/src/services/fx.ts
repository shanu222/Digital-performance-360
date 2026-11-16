import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { fxRates } from '../db/schema.js';
import { errorMessage, logger } from '../lib/logger.js';

/**
 * Optional currency conversion for display only. Source: ExchangeRate-API open endpoint
 * (https://open.er-api.com), which publishes daily mid-market rates incl. PKR.
 * The stored AdMob values always remain in the original reporting currency.
 */
export const FX_SOURCE = 'ExchangeRate-API (open.er-api.com)';

export async function getRate(base: string, quote: string): Promise<{ rate: number; source: string; fetchedAt: Date; rateDate: string } | null> {
  if (base === quote) return { rate: 1, source: 'identity', fetchedAt: new Date(), rateDate: new Date().toISOString().slice(0, 10) };
  const today = new Date().toISOString().slice(0, 10);
  const [cached] = await db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.base, base), eq(fxRates.quote, quote)))
    .orderBy(desc(fxRates.rateDate))
    .limit(1);
  if (cached && cached.rateDate === today) return cached;
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result: string; rates: Record<string, number>; time_last_update_utc?: string };
    if (body.result !== 'success') throw new Error('rate provider returned error');
    const rateDate = body.time_last_update_utc ? new Date(body.time_last_update_utc).toISOString().slice(0, 10) : today;
    for (const [q, r] of Object.entries(body.rates)) {
      if (!['USD', 'PKR', 'EUR', 'GBP'].includes(q) && q !== quote) continue;
      await db
        .insert(fxRates)
        .values({ base, quote: q, rate: r, source: FX_SOURCE, rateDate })
        .onConflictDoUpdate({ target: [fxRates.base, fxRates.quote, fxRates.rateDate], set: { rate: r, fetchedAt: new Date() } });
    }
    const rate = body.rates[quote];
    return rate ? { rate, source: FX_SOURCE, fetchedAt: new Date(), rateDate } : null;
  } catch (err) {
    logger.warn({ err: errorMessage(err), base, quote }, 'FX rate fetch failed; using last cached rate if any');
    return cached ?? null;
  }
}
