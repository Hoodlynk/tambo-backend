import bcrypt from 'bcryptjs';
import config from '../../config/config';
import type { ClientContext } from '../../config/client';
import PasswordResetToken from '../../models/passwordResetToken.model';
import User from '../../models/user.model';
import type { IUser } from '../../models/user.model';
import { AppError } from '../../utils/appError';
import { isDuplicateKeyError } from '../../utils/mongoErrors';
import { generateOpaqueToken, hashOpaqueToken } from '../../utils/tokens';
import * as audit from '../audit.service';
import * as notifier from '../notifier.service';
import * as otpService from '../otp.service';
import * as partnerService from '../partner.service';
import type { ChallengeSummary } from '../otp.service';
import * as sessionService from '../session.service';
import { clearLockout } from '../user.service';
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

export const hashPassword = (plain: string): Promise<string> =>
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
 * Creates an account and opens a signup OTP challenge - NO session yet. The
 * emailed code is the proof of mailbox possession; verification (otp.service
 * applyPurpose) sets emailVerifiedAt, binds any pending buddy invites, and
 * starts the first session.
 */
export const register = async (
  input: RegisterInput,
  userAgent?: string,
): Promise<ChallengeSummary> => {
  // an unknown code fails before anything is written
  const partner = input.partnerCode
    ? await partnerService.resolveForEnrolment(input.partnerCode)
    : null;
  const partnerFields = partnerService.signupFields(partner);
  const passwordHash = await hashPassword(input.password);

  // No exists() pre-check: the unique index is the authority, and translating
  // its violation avoids the race where two concurrent registrations both pass
  // a pre-check and the loser surfaces as a 500.
  let user: IUser;
  try {
    user = await User.create({
      name: input.name,
      email: input.email,
      passwordHash,
      ...partnerFields,
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    // The address is taken. If that account never proved the mailbox, this
    // registration SUPERSEDES it - possession of the mailbox (the code) is
    // what decides ownership, and an abandoned signup must not squat the
    // address forever. A verified account is a real conflict.
    const existing = await User.findOne({ email: input.email });
    if (!existing || existing.emailVerifiedAt) {
      throw AppError.conflict(
        'An account with that email already exists.',
        'email_taken',
      );
    }
    existing.name = input.name;
    existing.passwordHash = passwordHash;
    // the registration that proves the mailbox decides the partner, too
    existing.set('partner', partnerFields.partner);
    existing.plan = partnerFields.plan;
    existing.planSource = partnerFields.planSource;
    existing.set('planExpiresAt', undefined);
    await existing.save();
    user = existing;
  }

  // burns any previous signup challenge for this user - only the newest code works
  return otpService.createChallenge(user, 'signup', { userAgent });
};

/**
 * Password login. A verified account gets a session directly; an account whose
 * mailbox was never proven (abandoned signup) gets a login OTP challenge
 * instead - the password alone must not start a session for a mailbox nobody
 * has demonstrated owning. Verifying the code heals emailVerifiedAt.
 */
/**
 * Counts a failed login and locks the account at the threshold. Lockout sits
 * ON TOP of rate limiting: the limiter is keyed per email+IP, so a
 * distributed guess (many IPs, one account) slides under it - this counter is
 * per ACCOUNT and catches exactly that. Findandupdate is atomic, so parallel
 * failures cannot both slip past the threshold.
 */
const registerFailedLogin = async (
  user: IUser,
  context: audit.AuditContext,
): Promise<void> => {
  audit.record(user._id, 'login_failed', context);
  const updated = await User.findByIdAndUpdate(
    user._id,
    { $inc: { failedLoginAttempts: 1 } },
    { new: true },
  );
  if (updated && updated.failedLoginAttempts >= config.lockout.threshold) {
    // conditional on the counter still being at threshold: a successful
    // login that reset the counter in the meantime must win - otherwise an
    // in-flight failure could lock the owner out right AFTER they signed in
    const locked = await User.updateOne(
      {
        _id: user._id,
        failedLoginAttempts: { $gte: config.lockout.threshold },
      },
      {
        $set: {
          lockedUntil: new Date(
            Date.now() + config.lockout.durationMinutes * 60 * 1000,
          ),
          failedLoginAttempts: 0,
        },
      },
    );
    if (locked.modifiedCount > 0) {
      audit.record(user._id, 'account_locked', context);
    }
  }
};

export const login = async (
  input: LoginInput,
  userAgent?: string,
  ip?: string,
  client?: ClientContext,
): Promise<AuthResult | ChallengeSummary> => {
  const context: audit.AuditContext = { userAgent, ip };
  const user = await User.findOne({ email: input.email }).select(
    '+passwordHash',
  );

  // Locked accounts answer 423 regardless of the password: running the
  // comparison would let the lockout be used as a guessing oracle. The small
  // existence leak (423 needs a real account) is accepted and documented in
  // docs/security.md; reset-password clears the lock early.
  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(
      423,
      'Too many failed sign-in attempts. Try again later, or reset your password.',
      'account_locked',
      undefined,
      Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000),
    );
  }

  const matches = await bcrypt.compare(
    input.password,
    user?.passwordHash ?? DUMMY_HASH,
  );

  // One error for both "no such account" and "wrong password" - revealing which
  // would turn the login endpoint into an account-existence oracle.
  if (!user || !matches) {
    if (user) await registerFailedLogin(user, context);
    throw AppError.unauthorized(
      'Invalid email or password.',
      'invalid_credentials',
    );
  }

  if (user.failedLoginAttempts > 0 || user.lockedUntil) {
    await clearLockout(user._id.toString());
  }

  if (!user.emailVerifiedAt) {
    audit.record(user._id, 'login_challenged', context);
    return otpService.createChallenge(user, 'login', { userAgent });
  }

  audit.record(user._id, 'login_succeeded', context);
  return {
    user,
    tokens: await sessionService.startSession(user, userAgent, client),
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
export const requestPasswordReset = async (
  email: string,
  ip?: string,
): Promise<void> => {
  const user = await User.findOne({ email });
  if (!user) return;

  audit.record(user._id, 'password_reset_requested', { ip });

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
  notifier.sendEmail(
    {
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
    },
    'password_reset',
  );
};

/** Consumes a reset token, sets the new password, and evicts all old sessions. */
export const resetPassword = async (
  input: ResetPasswordInput,
  userAgent?: string,
  ip?: string,
  client?: ClientContext,
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
  // proving mailbox control via the reset link also clears any lockout - the
  // legitimate owner must never be locked out of their own recovery
  await clearLockout(user._id.toString());
  audit.record(user._id, 'password_reset', { userAgent, ip });
  return {
    user,
    tokens: await sessionService.startSession(user, userAgent, client),
  };
};
