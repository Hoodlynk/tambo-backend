import type { RequestHandler } from 'express';
import config from '../config/config';
import { AppError } from '../utils/appError';

/**
 * CSRF guard for the cookie-authenticated web surface. Two independent checks,
 * no server-side token state:
 *
 * 1. A required custom header. A cross-site form or top-level navigation
 *    cannot set one, and adding it to a script-driven cross-origin request
 *    forces a CORS preflight - which the deny-all-by-default allowlist
 *    rejects for foreign origins.
 * 2. When the browser supplies an Origin header it must be on the CORS
 *    allowlist. (Absent Origin is tolerated: same-site fetches in some
 *    browsers omit it, and check 1 already blocks the forgeable cases.)
 *
 * Mounted only on /api/auth/web - the sole surface where a cookie, not a
 * bearer header, carries authority. Bearer-token routes need no CSRF defence:
 * an attacker's page cannot read or attach the victim's token.
 */
export const CSRF_HEADER = 'x-tambo-csrf';

export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (!req.get(CSRF_HEADER)) {
    next(
      new AppError(
        403,
        `Missing the ${CSRF_HEADER} header.`,
        'csrf_rejected',
      ),
    );
    return;
  }

  const origin = req.get('origin');
  if (origin && !config.cors.allowedOrigins.includes(origin)) {
    next(
      new AppError(403, 'Origin not allowed.', 'csrf_rejected'),
    );
    return;
  }

  next();
};
