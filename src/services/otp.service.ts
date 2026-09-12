import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import config from '../config/config';
import OtpChallenge from '../models/otpChallenge.model';
import PasswordResetToken from '../models/passwordResetToken.model';
import * as buddyService from './buddy.service';
import type { IOtpChallenge, OtpPurpose } from '../models/otpChallenge.model';
import User from '../models/user.model';
import type { IUser } from '../models/user.model';
import { AppError } from '../utils/appError';
import { mailer } from './mailer';
import * as sessionService from './session.service';
import type { TokenPair } from './session.service';

/**
 * Email OTP: every authentication-changing action (signup, login, password
 * change, email change) is completed by proving a 6-digit code sent to the
 * relevant mailbox. The challenge carries the pending side effect, so nothing
 * changes until the code is verified.
 */

export interface ChallengeSummary {
  challengeId: string;
  purpose: OtpPurpose;
  expiresInMinutes: number;
}

export interface VerifiedSession {
  user: IUser;
  tokens: TokenPair;
}

interface ChallengeOptions {
  // `| undefined` so call sites can pass through optional values directly
  // under exactOptionalPropertyTypes; the create() spread drops undefined.
  pendingEmail?: string | undefined;
  pendingPasswordHash?: string | undefined;
  userAgent?: string | undefined;
}

/** crypto-random 6-digit code, uniform over 000000-999999. */
const generateCode = (): string =>
  crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

const SUBJECTS: Record<OtpPurpose, string> = {
  signup: 'Verify your Tambo account',
  login: 'Your Tambo sign-in code',
  password_change: 'Confirm your Tambo password change',
  email_change: 'Confirm your new Tambo email address',
};

const codeEmailText = (
  name: string,
  purpose: OtpPurpose,
  code: string,
): string =>
  [
    `Hi ${name},`,
    '',
    `Your verification code is: ${code}`,
    '',
    `It expires in ${config.otp.ttlMinutes} minutes and can only be used once.`,
    'If you did not request this, you can safely ignore this email.',
  ].join('\n');

/**
 * Fire-and-forget, matching the password-reset mail: a mail provider's latency
 * or outage must never block or time-fingerprint the auth endpoint. The client
 * recovers from a lost mail via /auth/otp/resend.
 */
const dispatchCode = (
  to: string,
  name: string,
  purpose: OtpPurpose,
  code: string,
): void => {
  void mailer
    .send({
      to,
      subject: SUBJECTS[purpose],
      text: codeEmailText(name, purpose, code),
    })
    .catch((error) => {
      console.error(`Failed to send ${purpose} OTP email:`, error);
    });
};

/**
 * Opens a challenge and emails the code. Any previous unconsumed challenge for
 * the same user+purpose is burned first, so only the newest code works.
 */
export const createChallenge = async (
  user: IUser,
  purpose: OtpPurpose,
  options: ChallengeOptions = {},
): Promise<ChallengeSummary> => {
  await OtpChallenge.updateMany(
    { user: user._id, purpose, consumedAt: { $exists: false } },
    { $set: { consumedAt: new Date() } },
  );

  const code = generateCode();
  const challenge = await OtpChallenge.create({
    user: user._id,
    purpose,
    codeHash: await bcrypt.hash(code, config.bcryptRounds),
    expiresAt: new Date(Date.now() + config.otp.ttlMinutes * 60 * 1000),
    lastSentAt: new Date(),
    ...(options.pendingEmail ? { pendingEmail: options.pendingEmail } : {}),
    ...(options.pendingPasswordHash
      ? { pendingPasswordHash: options.pendingPasswordHash }
      : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
  });

  // email_change codes go to the address being claimed; everything else to the
  // account's registered address
  const to =
    purpose === 'email_change' && options.pendingEmail
      ? options.pendingEmail
      : user.email;
  if (to) dispatchCode(to, user.name, purpose, code);

  return {
    challengeId: challenge._id.toString(),
    purpose,
    expiresInMinutes: config.otp.ttlMinutes,
  };
};

/**
 * Opens a fresh `signup` challenge for a signed-in account whose email was
 * never proven - a registration whose code was lost, or an account created
 * while verification was bypassed. Verifying it heals `emailVerifiedAt`
 * exactly as the registration code would have.
 */
export const requestEmailVerification = async (
  userId: string,
  userAgent?: string,
): Promise<ChallengeSummary> => {
  const user = await User.findById(userId);
  if (!user) throw AppError.unauthorized();

  if (!user.email) {
    throw AppError.badRequest(
      'This account has no email address to verify.',
      'no_email',
    );
  }
  if (user.emailVerifiedAt) {
    throw AppError.badRequest(
      'This email address is already verified.',
      'email_already_verified',
    );
  }

  return createChallenge(user, 'signup', { userAgent });
};

/**
 * Re-issues the code for a live challenge, cooldown-limited. The code is
 * rotated (never resent verbatim), and rotating resets neither expiry nor the
 * attempt budget - resending must not extend an attacker's window.
 */
export const resendChallenge = async (challengeId: string): Promise<void> => {
  const challenge = await OtpChallenge.findOne({
    _id: challengeId,
    consumedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  });

  if (!challenge) {
    throw AppError.unauthorized(
      'This verification is no longer active.',
      'invalid_challenge',
    );
  }

  const cooldownMs = config.otp.resendCooldownSeconds * 1000;
  const waitMs = challenge.lastSentAt.getTime() + cooldownMs - Date.now();
  if (waitMs > 0) {
    throw AppError.tooManyRequests(
      'Please wait before requesting another code.',
      Math.ceil(waitMs / 1000),
    );
  }

  const user = await User.findById(challenge.user);
  if (!user) {
    throw AppError.unauthorized(
      'This verification is no longer active.',
      'invalid_challenge',
    );
  }

  const code = generateCode();
  challenge.codeHash = await bcrypt.hash(code, config.bcryptRounds);
  challenge.lastSentAt = new Date();
  await challenge.save();

  const to =
    challenge.purpose === 'email_change' && challenge.pendingEmail
      ? challenge.pendingEmail
      : user.email;
  if (to) dispatchCode(to, user.name, challenge.purpose, code);
};

/**
 * A credential (password or login identifier) changed: evict every session and
 * every outstanding password-reset link - a link mailed before the change must
 * not be able to take the account afterwards (see docs/security.md).
 */
const revokeCredentialArtifacts = async (userId: string): Promise<void> => {
  await Promise.all([
    sessionService.revokeAllForUser(userId),
    PasswordResetToken.updateMany(
      { user: userId, usedAt: { $exists: false } },
      { $set: { usedAt: new Date() } },
    ),
  ]);
};

/** Applies the consumed challenge's purpose. Every purpose ends in a fresh session. */
const applyPurpose = async (
  challenge: IOtpChallenge,
  user: IUser,
  userAgent?: string,
): Promise<VerifiedSession> => {
  switch (challenge.purpose) {
    case 'signup':
    case 'login': {
      // a verified code proves control of the mailbox, so this also completes
      // (or heals) email verification
      if (!user.emailVerifiedAt) {
        user.emailVerifiedAt = new Date();
        await user.save();
      }
      // and binds any buddy invitations that were waiting on this email
      await buddyService.bindPendingInvites(user);
      break;
    }

    case 'password_change': {
      if (!challenge.pendingPasswordHash) {
        throw AppError.unauthorized(
          'This verification is no longer active.',
          'invalid_challenge',
        );
      }
      user.passwordHash = challenge.pendingPasswordHash;
      await user.save();
      await revokeCredentialArtifacts(user._id.toString());
      break;
    }

    case 'email_change': {
      const newEmail = challenge.pendingEmail;
      if (!newEmail) {
        throw AppError.unauthorized(
          'This verification is no longer active.',
          'invalid_challenge',
        );
      }
      // re-check: the address may have been claimed while the code was in flight
      if (await User.exists({ email: newEmail, _id: { $ne: user._id } })) {
        throw AppError.conflict(
          'An account with that email already exists.',
          'email_taken',
        );
      }
      user.email = newEmail;
      user.emailVerifiedAt = new Date(); // the code just proved the new mailbox
      await user.save();
      await buddyService.bindPendingInvites(user);
      // the login identifier changed - and reset links mailed to the OLD
      // address must die with it
      await revokeCredentialArtifacts(user._id.toString());
      break;
    }
  }

  const tokens = await sessionService.startSession(
    user,
    userAgent ?? challenge.userAgent,
  );
  return { user, tokens };
};

/**
 * Verifies a code. Wrong guesses are counted atomically and the challenge
 * burns at maxAttempts; a correct code CLAIMS the challenge atomically
 * (consumedAt flips only while unset), so a concurrent double-submit cannot
 * complete the same challenge twice.
 */
export const verifyChallenge = async (
  challengeId: string,
  code: string,
  userAgent?: string,
): Promise<VerifiedSession> => {
  const challenge = await OtpChallenge.findOne({
    _id: challengeId,
    consumedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  });

  if (!challenge || challenge.attempts >= config.otp.maxAttempts) {
    throw AppError.unauthorized(
      'This verification is no longer active. Please start again.',
      'invalid_challenge',
    );
  }

  if (!(await bcrypt.compare(code, challenge.codeHash))) {
    const updated = await OtpChallenge.findOneAndUpdate(
      { _id: challenge._id, consumedAt: { $exists: false } },
      { $inc: { attempts: 1 } },
      { new: true },
    );

    if (updated && updated.attempts >= config.otp.maxAttempts) {
      await OtpChallenge.updateOne(
        { _id: challenge._id, consumedAt: { $exists: false } },
        { $set: { consumedAt: new Date() } },
      );
      throw AppError.unauthorized(
        'Too many incorrect codes. Please start again.',
        'otp_attempts_exceeded',
      );
    }

    throw AppError.unauthorized('Incorrect code.', 'invalid_otp');
  }

  const claimed = await OtpChallenge.findOneAndUpdate(
    { _id: challenge._id, consumedAt: { $exists: false } },
    { $set: { consumedAt: new Date() } },
  );
  if (!claimed) {
    throw AppError.unauthorized(
      'This verification is no longer active. Please start again.',
      'invalid_challenge',
    );
  }

  const user = await User.findById(challenge.user).select('+passwordHash');
  if (!user) {
    throw AppError.unauthorized(
      'Account no longer exists.',
      'invalid_challenge',
    );
  }

  return applyPurpose(claimed, user, userAgent);
};
