import type { CookieOptions, Request, Response } from 'express';
import config from '../config/config';

/**
 * The browser surface's refresh-token cookie. httpOnly means page scripts can
 * never read it (the XSS-proofing that motivates the whole /api/auth/web
 * surface), and the path scopes it to the web auth routes so it rides on
 * refresh/logout only - never on ordinary API calls.
 */

/** Path-scoping is part of the design: keep in step with the mount in app.ts. */
export const WEB_AUTH_PATH = '/api/auth/web';

const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: config.authCookie.secure,
  sameSite: config.authCookie.sameSite,
  path: WEB_AUTH_PATH,
  // aligned with the token's own server-side lifetime
  maxAge: config.jwt.refreshTtlDays * 24 * 60 * 60 * 1000,
});

export const setRefreshCookie = (res: Response, token: string): void => {
  res.cookie(config.authCookie.name, token, cookieOptions());
};

export const clearRefreshCookie = (res: Response): void => {
  // clearCookie must repeat the attributes (minus maxAge) to match the cookie
  const { maxAge: _maxAge, ...options } = cookieOptions();
  res.clearCookie(config.authCookie.name, options);
};

export const readRefreshCookie = (req: Request): string | undefined => {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[config.authCookie.name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};
