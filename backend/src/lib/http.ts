import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z, type ZodType } from 'zod';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'bad_request', msg, details);

/** Standard success envelope: { ok: true, data, meta? } */
export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>, status = 200) {
  return res.status(status).json({ ok: true, data, ...(meta ? { meta } : {}) });
}

/** Wrap async handlers so rejections reach the central error handler. */
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new AppError(422, 'validation_error', 'Invalid request', z.treeifyError(r.error));
  }
  return r.data;
}
