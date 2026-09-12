import type { Request, Response } from 'express';
import * as passwordCredential from '../services/credentials/password.credential';
import type { AuthResult } from '../services/credentials/password.credential';
import * as otpService from '../services/otp.service';
import * as sessionService from '../services/session.service';
import * as userService from '../services/user.service';
import { authContext } from '../middlewares/auth.middleware';
import type {
  ChangeEmailInput,
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from '../validation/auth.schema';

/**
 * Controllers only marshal HTTP. Every body reaching them has already been
 * parsed and normalized by `validate(...)` in the route definition, so the
 * casts below are safe and no controller re-checks shapes.
 */

const userAgentOf = (req: Request): string | undefined => req.get('user-agent');

/** The one place the auth response envelope is shaped. */
const sendAuthResult = (
  res: Response,
  result: AuthResult,
  status = 200,
): void => {
  res
    .status(status)
    .json({ user: result.user.toJSON(), tokens: result.tokens });
};

/** Pending-OTP envelope: the client's next move is POST /auth/otp/verify. */
const sendChallenge = (
  res: Response,
  challenge: otpService.ChallengeSummary,
  status = 200,
): void => {
  res.status(status).json({ challenge });
};

// --- Credential entry points -------------------------------------------------

/** No tokens yet: the client's next move is POST /auth/otp/verify. */
export const register = async (req: Request, res: Response): Promise<void> => {
  sendChallenge(
    res,
    await passwordCredential.register(
      req.body as RegisterInput,
      userAgentOf(req),
    ),
    201,
  );
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const result = await passwordCredential.login(
    req.body as LoginInput,
    userAgentOf(req),
  );

  if (result.status === 'verification_required') {
    // The standard error envelope (branch on `code`), plus the challenge that
    // completes the signup - AppError has no payload slot, so shaped here.
    res.status(403).json({
      code: 'email_unverified',
      message: 'Verify your email address to finish signing up.',
      challenge: result.challenge,
    });
    return;
  }

  sendAuthResult(res, result.session);
};

export const changePassword = async (
  req: Request,
  res: Response,
): Promise<void> => {
  sendChallenge(
    res,
    await passwordCredential.changePassword(
      authContext(req).userId,
      req.body as ChangePasswordInput,
      userAgentOf(req),
    ),
  );
};

export const changeEmail = async (
  req: Request,
  res: Response,
): Promise<void> => {
  sendChallenge(
    res,
    await passwordCredential.changeEmail(
      authContext(req).userId,
      req.body as ChangeEmailInput,
      userAgentOf(req),
    ),
  );
};

export const requestEmailVerification = async (
  req: Request,
  res: Response,
): Promise<void> => {
  sendChallenge(
    res,
    await otpService.requestEmailVerification(
      authContext(req).userId,
      userAgentOf(req),
    ),
  );
};

// --- OTP completion ----------------------------------------------------------

export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  const { challengeId, code } = req.body as {
    challengeId: string;
    code: string;
  };
  sendAuthResult(
    res,
    await otpService.verifyChallenge(challengeId, code, userAgentOf(req)),
  );
};

export const resendOtp = async (req: Request, res: Response): Promise<void> => {
  const { challengeId } = req.body as { challengeId: string };
  await otpService.resendChallenge(challengeId);
  res.status(204).send();
};

// --- Sessions ----------------------------------------------------------------

export const refresh = async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body as { refreshToken: string };
  sendAuthResult(
    res,
    await sessionService.refresh(refreshToken, userAgentOf(req)),
  );
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body as { refreshToken: string };
  await sessionService.revokeByToken(refreshToken);
  res.status(204).send();
};

export const logoutAll = async (req: Request, res: Response): Promise<void> => {
  await sessionService.revokeAllForUser(authContext(req).userId);
  res.status(204).send();
};

export const me = async (req: Request, res: Response): Promise<void> => {
  const user = await userService.getById(authContext(req).userId);
  res.status(200).json({ user: user.toJSON() });
};

/**
 * The client may pass its own refresh token in `X-Refresh-Token` to have its
 * row flagged `current: true`. A header rather than a query parameter because
 * query strings land in access logs and proxy caches.
 */
export const listSessions = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const sessions = await sessionService.listSessions(
    authContext(req).userId,
    req.get('x-refresh-token'),
  );
  res.status(200).json({ sessions });
};

export const revokeSession = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params as { id: string };
  await sessionService.revokeSessionById(authContext(req).userId, id);
  res.status(204).send();
};

// --- Password recovery (link-based, deliberately - see password.credential) --

/**
 * Always 204, even for an unknown email. Any other behaviour would let an
 * attacker enumerate registered addresses.
 */
export const forgotPassword = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { email } = req.body as { email: string };
  await passwordCredential.requestPasswordReset(email);
  res.status(204).send();
};

export const resetPassword = async (
  req: Request,
  res: Response,
): Promise<void> => {
  sendAuthResult(
    res,
    await passwordCredential.resetPassword(
      req.body as ResetPasswordInput,
      userAgentOf(req),
    ),
  );
};
