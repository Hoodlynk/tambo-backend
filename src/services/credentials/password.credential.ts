import bcrypt from 'bcryptjs';
import config from '../../config/config';
import PasswordResetToken from '../../models/passwordResetToken.model';
import User from '../../models/user.model';
import type { IUser } from '../../models/user.model';
import { AppError } from '../../utils/appError';
import { isDuplicateKeyError } from '../../utils/mongoErrors';
import { generateOpaqueToken, hashOpaqueToken } from '../../utils/tokens';
import { mailer } from '../mailer';
import * as otpService from '../otp.service';
import type { ChallengeSummary } from '../otp.service';
import * as sessionService from '../session.service';
import type { TokenPair } from '../session.service';
import type {
  ChangeEmailInput,
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from '../../validation/auth.schema';

/**
 * Email + password credentials. This module is the ONLY place that knows about
 * passwords; session issuance lives in session.service, while sensitive
 * credential changes are completed through an emailed OTP (otp.service).
 * A future otp SMS credential can reuse the same session machinery.
 */

export interface AuthResult {
  user: IUser;
  tokens: TokenPair;
}

/**
 * A real bcrypt hash of a value nobody can supply. Comparing against it when
 * the account does not exist keeps login's response time roughly constant, so
 * timing cannot be used to discover which emails are registered.
 */
const DUMMY_HASH =
  '$2b$12$2g05wDqWWn9kMCABYg.ORujVXYdM3wD1LSeZgoimOCSWGBBUF.L9W';

const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, config.bcryptRounds);

/**
 * The single mechanism for setting a password directly (the reset flow, where
 * the token itself is the proof). Every credential an attacker might be
 * holding dies with it: all refresh sessions are revoked AND every outstanding
 * password-reset token is invalidated.
 *
 * Interactive password changes go through the OTP flow instead
 * (changePassword below), which applies the same revocations on verify.
 */
const setPassword = async (user: IUser, newPassword: string): Promise<void> => {
  user.passwordHash = await hashPassword(newPassword);
  await user.save();

  await Promise.all([
    sessionService.revokeAllForUser(user._id.toString()),
    PasswordResetToken.updateMany(
      { user: user._id, usedAt: { $exists: false } },
      { $set: { usedAt: new Date() } },
    ),
  ]);
};

/**
 * Creates the (unverified) account and opens a `signup` challenge. No session
 * is issued here: the first token pair only exists once the emailed code has
 * proven the mailbox (otp.service applies `emailVerifiedAt`, binds any buddy
 * invites waiting on the address, and starts the session). A lost code is
 * recovered with /otp/resend, or by logging in again - see `login`.
 */
export const register = async (
  input: RegisterInput,
  userAgent?: string,
): Promise<ChallengeSummary> => {
  // No exists() pre-check: the unique index is the authority, and translating
  // its violation avoids the race where two concurrent registrations both pass
  // a pre-check and the loser surfaces as a 500.
  let user: IUser;
  try {
    user = await User.create({
      name: input.name,
      email: input.email,
      passwordHash: await hashPassword(input.password),
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw AppError.conflict(
        'An account with that email already exists.',
        'email_taken',
      );
    }
    throw error;
  }

  return otpService.createChallenge(user, 'signup', { userAgent });
};

/**
 * A correct password yields a session - unless the account never completed
 * its signup verification, in which case it yields a fresh `signup` challenge
 * instead, so the user can finish verifying and get their first session.
 */
export type LoginResult =
  | { status: 'authenticated'; session: AuthResult }
  | { status: 'verification_required'; challenge: ChallengeSummary };

/** Password login; a session is only ever started for a verified email. */
export const login = async (
  input: LoginInput,
  userAgent?: string,
): Promise<LoginResult> => {
  const user = await User.findOne({ email: input.email }).select(
    '+passwordHash',
  );
  const matches = await bcrypt.compare(
    input.password,
    user?.passwordHash ?? DUMMY_HASH,
  );

  // One error for both "no such account" and "wrong password" - revealing which
  // would turn the login endpoint into an account-existence oracle.
  if (!user || !matches) {
    throw AppError.unauthorized(
      'Invalid email or password.',
      'invalid_credentials',
    );
  }

  // The password checked out, but the mailbox never did: no session. Only
  // reached after a correct password, so this is not an existence oracle.
  if (!user.emailVerifiedAt) {
    return {
      status: 'verification_required',
      challenge: await otpService.createChallenge(user, 'signup', {
        userAgent,
      }),
    };
  }

  return {
    status: 'authenticated',
    session: {
      user,
      tokens: await sessionService.startSession(user, userAgent),
    },
  };
};

/**
 * Step 1 of a password change: prove the current password, then park the NEW
 * password's hash on an OTP challenge. Nothing changes until the emailed code
 * is verified; the verify step applies the hash and revokes every other
 * session and outstanding reset link.
 */
export const changePassword = async (
  userId: string,
  input: ChangePasswordInput,
  userAgent?: string,
): Promise<ChallengeSummary> => {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw AppError.unauthorized();

  if (!user.passwordHash) {
    throw AppError.badRequest(
      'This account has no password set.',
      'no_password_credential',
    );
  }

  if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
    throw AppError.unauthorized(
      'Current password is incorrect.',
      'invalid_credentials',
    );
  }

  return otpService.createChallenge(user, 'password_change', {
    pendingPasswordHash: await hashPassword(input.newPassword),
    userAgent,
  });
};

/**
 * Step 1 of an email change: prove the password, check the new address is
 * free, then send the code to the NEW address - possession of the new mailbox
 * is what authorizes the change. Applied on verify, which also revokes every
 * other session (the login identifier changed).
 */
export const changeEmail = async (
  userId: string,
  input: ChangeEmailInput,
  userAgent?: string,
): Promise<ChallengeSummary> => {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw AppError.unauthorized();

  if (!user.passwordHash) {
    throw AppError.badRequest(
      'This account has no password set.',
      'no_password_credential',
    );
  }

  if (!(await bcrypt.compare(input.password, user.passwordHash))) {
    throw AppError.unauthorized(
      'Password is incorrect.',
      'invalid_credentials',
    );
  }

  if (input.newEmail === user.email) {
    throw AppError.badRequest(
      "That is already this account's email address.",
      'email_unchanged',
    );
  }

  // Early courtesy check; the verify step re-checks atomically since the
  // address can be claimed while the code is in flight.
  if (await User.exists({ email: input.newEmail })) {
    throw AppError.conflict(
      'An account with that email already exists.',
      'email_taken',
    );
  }

  return otpService.createChallenge(user, 'email_change', {
    pendingEmail: input.newEmail,
    userAgent,
  });
};

/**
 * Always resolves, whether or not the email exists - the endpoint must not
 * reveal who has an account. Any outstanding reset token is invalidated so only
 * the newest link works. Link-based rather than challenge-based on purpose:
 * returning a challengeId here would leak which emails are registered.
 */
export const requestPasswordReset = async (email: string): Promise<void> => {
  const user = await User.findOne({ email });
  if (!user) return;

  await PasswordResetToken.updateMany(
    { user: user._id, usedAt: { $exists: false } },
    { $set: { usedAt: new Date() } },
  );

  const token = generateOpaqueToken();
  await PasswordResetToken.create({
    user: user._id,
    tokenHash: hashOpaqueToken(token),
    expiresAt: new Date(
      Date.now() + config.passwordReset.ttlMinutes * 60 * 1000,
    ),
  });

  // Fire-and-forget, deliberately: awaiting a real mail provider here would
  // make response latency reveal whether the email exists (known address =
  // provider round trip, unknown = instant), re-opening the enumeration hole
  // the unconditional 204 exists to close - and a provider outage would take
  // this endpoint down with it.
  void mailer
    .send({
      to: email,
      subject: 'Reset your Tambo password',
      text: [
        `Hi ${user.name},`,
        '',
        'Use the link below to choose a new password. It expires in ' +
          `${config.passwordReset.ttlMinutes} minutes and can only be used once.`,
        '',
        `${config.mail.appUrl}reset-password?token=${token}`,
        '',
        'If you did not request this, you can safely ignore this email.',
      ].join('\n'),
    })
    .catch((error) => {
      console.error('Failed to send password reset email:', error);
    });
};

/** Consumes a reset token, sets the new password, and evicts all old sessions. */
export const resetPassword = async (
  input: ResetPasswordInput,
  userAgent?: string,
): Promise<AuthResult> => {
  // Atomic claim, same discipline as refresh rotation: only one concurrent
  // presenter of this token can flip usedAt, so the token is truly single-use.
  const claimed = await PasswordResetToken.findOneAndUpdate(
    {
      tokenHash: hashOpaqueToken(input.token),
      usedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
  );

  if (!claimed) {
    throw AppError.unauthorized(
      'This password reset link is invalid or has expired.',
      'invalid_reset_token',
    );
  }

  const user = await User.findById(claimed.user).select('+passwordHash');
  if (!user) {
    throw AppError.unauthorized(
      'Account no longer exists.',
      'invalid_reset_token',
    );
  }

  await setPassword(user, input.password);
  return { user, tokens: await sessionService.startSession(user, userAgent) };
};
