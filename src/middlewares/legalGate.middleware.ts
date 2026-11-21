import type { RequestHandler } from 'express';
import { authContext } from './auth.middleware';
import config from '../config/config';
import * as legalService from '../services/legal.service';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';

/**
 * Blocks an action until the user has accepted the CURRENT version of every
 * legal document (T&C + privacy). Mounted AFTER requireAuth.
 *
 * Deliberately applied only to actions that START a data-processing
 * relationship (device enrolment - the point where unlock/location collection
 * begins), not to every endpoint: a version bump must re-prompt users, not
 * brick an already-protected phone mid-theft.
 */
export const requireLegalAcceptance: RequestHandler = (req, _res, next) => {
  legalService
    .hasAcceptedCurrent(authContext(req).userId)
    .then((accepted) => {
      if (accepted) {
        next();
        return;
      }
      next(
        AppError.forbidden(
          'Please review and accept the current Terms & Conditions and ' +
            'Privacy Policy first.',
          'legal_acceptance_required',
        ),
      );
    })
    .catch(next);
};

/**
 * Enrolment's gate. Identical to requireLegalAcceptance except for builds
 * that send no X-Client-Platform: the build on Play collects consent in an
 * in-app sheet but never records it server-side, so strict gating would
 * silently stop every new or re-enrolling install from sending evidence.
 * Owner decision 2026-11-21; LEGACY_CLIENT_LEGAL_EXEMPT=false closes it.
 */
export const requireLegalAcceptanceForEnrolment: RequestHandler = (
  req,
  res,
  next,
) => {
  if (config.legacyClients.legalExempt && !req.client?.platform) {
    // the count of these is how the owner knows the flag can be switched off
    logger.info(
      { userId: authContext(req).userId },
      'legacy client enrolling without a recorded legal acceptance',
    );
    next();
    return;
  }
  requireLegalAcceptance(req, res, next);
};
