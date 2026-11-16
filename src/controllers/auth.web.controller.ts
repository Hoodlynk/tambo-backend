import type { Request, Response } from 'express';
import * as passwordCredential from '../services/credentials/password.credential';
import type { AuthResult } from '../services/credentials/password.credential';
import * as otpService from '../services/otp.service';
import * as sessionService from '../services/session.service';
import { AppError } from '../utils/appError';
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from '../utils/refreshCookie';
import type { LoginInput, ResetPasswordInput } from '../validation/auth.schema';
import { isChallenge, sendChallenge, userAgentOf } from './auth.controller';

/**
 * The browser (PWA) auth surface. Same services, same session machinery as
 * the mobile controller - the ONLY difference is where the refresh token
 * travels: an httpOnly cookie instead of the JSON body. The access token is
 * still returned in the body; the PWA holds it in memory only.
 */

/** Cookie set, refreshToken withheld from the body - the surface's whole point. */
const sendWebAuthResult = (
  res: Response,
  result: AuthResult,
  status = 200,
): void => {
  setRefreshCookie(res, result.tokens.refreshToken);
  res.status(status).json({
    user: result.user.toJSON(),
    tokens: {
      accessToken: result.tokens.accessToken,
      expiresIn: result.tokens.expiresIn,
    },
  });
};

const requireCookie = (req: Request): string => {
  const token = readRefreshCookie(req);
  if (!token) {
    throw AppError.unauthorized(
      'No refresh cookie. Sign in again.',
      'missing_refresh_cookie',
    );
  }
  return token;
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const result = await passwordCredential.login(
    req.body as LoginInput,
    userAgentOf(req),
    req.ip,
    req.client,
  );
  // unproven mailbox: the SAME challenge envelope as mobile; no cookie yet
  if (isChallenge(result)) {
    sendChallenge(res, result);
    return;
  }
  sendWebAuthResult(res, result);
};

export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  const { challengeId, code } = req.body as {
    challengeId: string;
    code: string;
  };
  sendWebAuthResult(
    res,
    await otpService.verifyChallenge(
      challengeId,
      code,
      userAgentOf(req),
      req.ip,
      req.client,
    ),
  );
};

export const refresh = async (req: Request, res: Response): Promise<void> => {
  const result = await sessionService.refresh(
    requireCookie(req),
    userAgentOf(req),
    req.client,
  );
  sendWebAuthResult(res, result);
};

/** Reset completes with a cookie session - the PWA must never hold a body
 *  refresh token, and a reset that strands the user at re-login defeats the
 *  recovery flow. */
export const resetPassword = async (
  req: Request,
  res: Response,
): Promise<void> => {
  sendWebAuthResult(
    res,
    await passwordCredential.resetPassword(
      req.body as ResetPasswordInput,
      userAgentOf(req),
      req.ip,
      req.client,
    ),
  );
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  const token = readRefreshCookie(req);
  if (token) await sessionService.revokeByToken(token);
  clearRefreshCookie(res);
  res.status(204).send();
};
