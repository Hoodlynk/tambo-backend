import crypto from 'crypto';
import type { RequestHandler } from 'express';
import { logger } from '../utils/logger';

/**
 * Every request gets an id: an inbound X-Request-Id is honoured when it looks
 * sane (so ids correlate across the proxy chain), otherwise one is minted.
 * The id is echoed in the response header - "what's your request id?" is the
 * first support question - and every log line for the request carries it.
 */
const SANE_ID = /^[\w.-]{4,64}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.get('x-request-id');
  const id = inbound && SANE_ID.test(inbound) ? inbound : crypto.randomUUID();
  req.requestId = id;
  res.set('X-Request-Id', id);
  next();
};

/** One structured line per completed request. */
export const requestLog: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    logger.info(
      {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        ip: req.ip,
      },
      'request',
    );
  });
  next();
};
