import type { Request, RequestHandler } from 'express';
import * as partnerService from '../services/partner.service';
import type { PartnerPrincipal } from '../services/partner.service';
import { AppError } from '../utils/appError';

/**
 * Authenticates a PARTNER system by its API key in X-Api-Key. Machine
 * credentials only: a user JWT is never accepted here, and a partner key is
 * never accepted on user or device routes.
 */
export const requirePartnerApiKey: RequestHandler = (req, _res, next) => {
  const key = req.get('x-api-key');
  if (!key) {
    next(AppError.unauthorized('Missing API key.', 'missing_api_key'));
    return;
  }

  partnerService
    .authenticateApiKey(key)
    .then((principal) => {
      if (!principal) {
        next(
          AppError.unauthorized(
            'API key is invalid or revoked.',
            'invalid_api_key',
          ),
        );
        return;
      }
      req.partner = principal;
      next();
    })
    .catch(next);
};

/** Narrows `req.partner` for handlers mounted behind requirePartnerApiKey. */
export const partnerContext = (req: Request): PartnerPrincipal => {
  if (!req.partner) throw AppError.unauthorized();
  return req.partner;
};
