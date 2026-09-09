import type { RequestHandler } from 'express';
import { authContext } from './auth.middleware';
import * as legalService from '../services/legal.service';
import { AppError } from '../utils/appError';

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
