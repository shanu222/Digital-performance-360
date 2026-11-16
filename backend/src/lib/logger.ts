import pino from 'pino';
import { env, isProd } from '../config/env.js';

/** Any key matching these paths is replaced with [REDACTED] — tokens never reach logs. */
const redact = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.access_token',
  '*.refresh_token',
  '*.accessToken',
  '*.refreshToken',
  '*.id_token',
  '*.password',
  '*.client_secret',
  '*.private_key',
  'tokens',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redact, censor: '[REDACTED]' },
  transport: isProd || env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty', options: { colorize: true } },
});

/** Strip anything that looks like a bearer/OAuth token from error messages before storing/logging. */
export function scrub(message: string): string {
  return message
    .replace(/ya29\.[\w.-]+/g, '[REDACTED]')
    .replace(/1\/\/[\w.-]{20,}/g, '[REDACTED]')
    .replace(/Bearer\s+[\w.-]+/gi, 'Bearer [REDACTED]')
    .replace(/"private_key"\s*:\s*"[^"]+"/g, '"private_key":"[REDACTED]"');
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const anyErr = err as { response?: { data?: { error?: { message?: string } | string; error_description?: string } }; message?: string };
    const data = anyErr.response?.data;
    if (data) {
      if (typeof data.error === 'object' && data.error?.message) return scrub(data.error.message);
      if (typeof data.error === 'string') return scrub(`${data.error}${data.error_description ? `: ${data.error_description}` : ''}`);
    }
    if (anyErr.message) return scrub(anyErr.message);
  }
  return scrub(String(err));
}
