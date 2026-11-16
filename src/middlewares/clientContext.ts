import type { RequestHandler } from 'express';
import { CLIENT_PLATFORMS, SEMVER_PATTERN } from '../config/client';
import type { ClientContext, ClientPlatform } from '../config/client';

/**
 * Reads X-Client-Platform / X-Client-Version on every request. Advisory
 * only: a missing or malformed value is dropped rather than rejected, because
 * builds that predate the headers must keep working (and a stolen phone's
 * evidence upload must never fail over a header).
 */
export const clientContext: RequestHandler = (req, _res, next) => {
  const platform = req.get('x-client-platform')?.trim().toLowerCase();
  const version = req.get('x-client-version')?.trim();

  const context: ClientContext = {};
  if (platform && (CLIENT_PLATFORMS as readonly string[]).includes(platform)) {
    context.platform = platform as ClientPlatform;
  }
  if (version && SEMVER_PATTERN.test(version)) context.version = version;
  req.client = context;
  next();
};
