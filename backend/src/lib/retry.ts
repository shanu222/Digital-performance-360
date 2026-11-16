import { errorMessage, logger } from './logger.js';

function statusOf(err: unknown): number | undefined {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  const s = e?.response?.status ?? e?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
  return typeof s === 'number' ? s : undefined;
}

export function isRetryable(err: unknown): boolean {
  const s = statusOf(err);
  if (s === 429 || (s !== undefined && s >= 500)) return true;
  const code = (err as { code?: string })?.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET'].includes(String(code));
}

export function isAuthError(err: unknown): boolean {
  const s = statusOf(err);
  const msg = errorMessage(err);
  return s === 401 || /invalid_grant|unauthorized_client|Token has been expired or revoked/i.test(msg);
}

export function isPermissionError(err: unknown): boolean {
  return statusOf(err) === 403;
}

/** Retry with exponential backoff + jitter for quota (429) and transient (5xx/network) failures. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; label?: string } = {},
): Promise<T> {
  const retries = opts.retries ?? 4;
  const base = opts.baseMs ?? 1000;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delay = Math.min(60_000, base * 2 ** attempt) + Math.floor(Math.random() * 250);
      logger.warn({ label: opts.label, attempt: attempt + 1, delay, status: statusOf(err) }, 'Retrying Google API call');
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    }
  }
}
