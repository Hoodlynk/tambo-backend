import type { NextFunction, Request, Response } from 'express';
import config from '../config/config';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { isDuplicateKeyError } from '../utils/mongoErrors';

/** Anything that falls through to here without a matching route. */
export const notFoundHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  next(
    AppError.notFound(
      `Route ${req.method} ${req.originalUrl} does not exist.`,
      'route_not_found',
    ),
  );
};

/**
 * Known non-AppError failures translated to client-visible errors. Everything
 * this does not recognise is treated as a bug and becomes an opaque 500.
 */
const translate = (err: Error): AppError | null => {
  if (err instanceof AppError) return err;

  // express.json() (body-parser) tags its errors with `type`
  const type = (err as { type?: string }).type;
  if (type === 'entity.parse.failed') {
    return AppError.badRequest(
      'Request body is not valid JSON.',
      'invalid_json',
    );
  }
  if (type === 'entity.too.large') {
    return new AppError(413, 'Request body is too large.', 'payload_too_large');
  }

  // Unique-index violations are client conflicts, not server bugs. Services
  // usually translate these themselves with a specific code (e.g. email_taken);
  // this is the backstop for any unique field a service forgets to handle.
  if (isDuplicateKeyError(err)) {
    return AppError.conflict(
      'A record with that value already exists.',
      'duplicate_key',
    );
  }

  return null;
};

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- express detects error middleware by arity
  _next: NextFunction,
): void => {
  const known = translate(err);

  if (known) {
    // One structured line per expected failure, so auth attacks (credential
    // stuffing, token replay) are visible in logs. Silent in tests (level).
    logger.warn(
      {
        requestId: req.requestId,
        status: known.statusCode,
        code: known.code,
        method: req.method,
        path: req.originalUrl,
        ip: req.ip,
      },
      'request failed',
    );

    if (known.retryAfterSeconds !== undefined) {
      res.set('Retry-After', String(known.retryAfterSeconds));
    }
    res.status(known.statusCode).json({
      code: known.code,
      message: known.message,
      ...(known.details ? { details: known.details } : {}),
      ...(known.retryAfterSeconds !== undefined
        ? { retryAfter: known.retryAfterSeconds }
        : {}),
    });
    return;
  }

  // Unrecognised errors are bugs: log them in full, tell the client nothing.
  // `isDevelopment` is true only when NODE_ENV is EXPLICITLY development, so a
  // deployment that forgets to set NODE_ENV does not leak internals.
  logger.error(
    { requestId: req.requestId, err, method: req.method, path: req.originalUrl },
    'unhandled error',
  );
  res.status(500).json({
    code: 'internal_error',
    message: 'Something went wrong!',
    ...(config.isDevelopment ? { detail: err.message } : {}),
  });
};
