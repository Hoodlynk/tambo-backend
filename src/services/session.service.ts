import crypto from 'crypto';
import config from '../config/config';
import BurnedFamily from '../models/burnedFamily.model';
import RefreshToken from '../models/refreshToken.model';
import User from '../models/user.model';
import type { IUser } from '../models/user.model';
import { AppError } from '../utils/appError';
import PushToken from '../models/pushToken.model';
import * as audit from './audit.service';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  signAccessToken,
} from '../utils/tokens';

/**
 * Session mechanics, deliberately credential-agnostic. Nothing here knows or
 * cares HOW the user proved who they are - only that someone already did.
 * That is what lets phone-OTP login reuse all of this untouched.
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

export interface SessionSummary {
  id: string;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  current: boolean;
}

const refreshExpiryDate = (): Date =>
  new Date(Date.now() + config.jwt.refreshTtlDays * 24 * 60 * 60 * 1000);

/**
 * Burns a family: tombstone FIRST, then the bulk revoke. Any token written
 * after the tombstone exists is caught by the use-time check in refresh();
 * any token written before is caught by the updateMany. Between the two,
 * no interleaving lets a descendant survive.
 */
const burnFamily = async (family: string): Promise<void> => {
  await BurnedFamily.updateOne(
    { family },
    { $setOnInsert: { expiresAt: refreshExpiryDate() } },
    { upsert: true },
  );
  await RefreshToken.updateMany(
    { family, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
};

/**
 * Issues an access/refresh pair. `family` ties rotated tokens together: every
 * refresh descends from the same login, so a replayed token can invalidate the
 * entire lineage rather than just itself.
 */
export const issueTokens = async (
  user: IUser,
  family: string,
  userAgent?: string,
): Promise<TokenPair> => {
  const refreshToken = generateOpaqueToken();

  await RefreshToken.create({
    user: user._id,
    tokenHash: hashOpaqueToken(refreshToken),
    family,
    expiresAt: refreshExpiryDate(),
    ...(userAgent ? { userAgent } : {}),
  });

  return {
    accessToken: signAccessToken({ sub: user._id.toString(), role: user.role }),
    refreshToken,
    expiresIn: config.jwt.accessTtl,
  };
};

/** Starts a brand new session lineage. Called after any successful login. */
export const startSession = (
  user: IUser,
  userAgent?: string,
): Promise<TokenPair> => issueTokens(user, crypto.randomUUID(), userAgent);

/**
 * Rotates a refresh token.
 *
 * Rejected when unknown, expired, or already revoked. The already-revoked case
 * is special: a token can only be presented twice if it leaked, so the whole
 * family is burned and every descendant session dies with it.
 *
 * The rotation CLAIMS the token atomically - one findOneAndUpdate that flips
 * revokedAt only while it is still unset - rather than read-check-write. Under
 * concurrency exactly one presenter wins; every other simultaneous presenter
 * falls into the reuse branch. (A non-atomic version let two parallel
 * presentations both succeed, silently defeating reuse detection.)
 */
export const refresh = async (
  token: string,
  userAgent?: string,
): Promise<{ user: IUser; tokens: TokenPair }> => {
  const tokenHash = hashOpaqueToken(token);

  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );

  if (!claimed) {
    // Unclaimable: unknown, or already revoked - and "already revoked"
    // includes losing the claim race above, which is precisely a replay.
    const stored = await RefreshToken.findOne({ tokenHash });

    if (stored?.revokedAt) {
      await burnFamily(stored.family);
      throw AppError.unauthorized(
        'Refresh token has already been used. Please sign in again.',
        'refresh_token_reused',
      );
    }

    throw AppError.unauthorized(
      'Invalid or expired refresh token.',
      'invalid_refresh_token',
    );
  }

  if (claimed.expiresAt.getTime() <= Date.now()) {
    throw AppError.unauthorized(
      'Invalid or expired refresh token.',
      'invalid_refresh_token',
    );
  }

  // use-time checks that close the races bulk revocation cannot win:
  // a burned family stays dead, and "sign out everywhere" kills every token
  // created at or before its watermark - even one written concurrently.
  const [familyBurned, user] = await Promise.all([
    BurnedFamily.exists({ family: claimed.family }),
    User.findById(claimed.user),
  ]);

  if (familyBurned) {
    throw AppError.unauthorized(
      'Invalid or expired refresh token.',
      'invalid_refresh_token',
    );
  }
  if (!user) {
    throw AppError.unauthorized(
      'Account no longer exists.',
      'invalid_refresh_token',
    );
  }
  // Strictly `<`: a session started in the same millisecond as the watermark
  // (setPassword revokes, then immediately starts a fresh session) must live.
  if (
    user.sessionsInvalidatedAt &&
    claimed.createdAt.getTime() < user.sessionsInvalidatedAt.getTime()
  ) {
    throw AppError.unauthorized(
      'Invalid or expired refresh token.',
      'invalid_refresh_token',
    );
  }

  const tokens = await issueTokens(user, claimed.family, userAgent);

  // Post-issue confirmation, closing the last interleaving: if a burn or a
  // bulk revoke began between our pre-checks and our token write, either its
  // updateMany ran after the write (and swept it), or its marker was written
  // before this read (and we self-revoke here). No ordering lets the fresh
  // token survive a revocation it should be covered by.
  const [burnedNow, userNow] = await Promise.all([
    BurnedFamily.exists({ family: claimed.family }),
    User.findById(claimed.user).select('sessionsInvalidatedAt'),
  ]);
  const invalidatedNow =
    !userNow ||
    (userNow.sessionsInvalidatedAt !== undefined &&
      claimed.createdAt.getTime() < userNow.sessionsInvalidatedAt.getTime());

  if (burnedNow || invalidatedNow) {
    await revokeByToken(tokens.refreshToken);
    throw AppError.unauthorized(
      'Invalid or expired refresh token.',
      'invalid_refresh_token',
    );
  }

  return { user, tokens };
};

/** Revokes a single session. Idempotent: unknown or already-revoked tokens are a no-op. */
export const revokeByToken = async (token: string): Promise<void> => {
  const revoked = await RefreshToken.findOneAndUpdate(
    { tokenHash: hashOpaqueToken(token), revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
  // logout belongs on the owner's security timeline like every other
  // revocation - an incomplete ledger is worse than none
  if (revoked) {
    audit.record(revoked.user, 'session_revoked', {
      meta: { sessionId: revoked._id.toString(), via: 'logout' },
    });
  }
};

/**
 * Revokes every live session for a user. Called on "sign out everywhere", and
 * automatically on password change or reset - a stolen session must not
 * survive the user reacting to the theft.
 */
export const revokeAllForUser = async (userId: string): Promise<void> => {
  // Watermark FIRST (same ordering argument as burnFamily): rotations that
  // land a new token after this instant are rejected at use time, rotations
  // that landed before are swept by the updateMany.
  await User.updateOne(
    { _id: userId },
    { $set: { sessionsInvalidatedAt: new Date() } },
  );
  await RefreshToken.updateMany(
    { user: userId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
  // push registrations are session-adjacent capability: a stolen session
  // evicted here must not keep receiving this account's theft alerts. The
  // owner's own devices re-register on next app start (the documented
  // contract), so the cost is one silent gap, not lost protection.
  await PushToken.deleteMany({ user: userId });
  audit.record(userId, 'sessions_revoked_all');
};

/** Powers a "signed in on these devices" screen. */
export const listSessions = async (
  userId: string,
  currentToken?: string,
): Promise<SessionSummary[]> => {
  const currentHash = currentToken ? hashOpaqueToken(currentToken) : null;

  const sessions = await RefreshToken.find({
    user: userId,
    revokedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  return sessions.map((session) => ({
    id: session._id.toString(),
    userAgent: session.userAgent ?? null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    current: currentHash !== null && session.tokenHash === currentHash,
  }));
};

/** Revokes one named session belonging to the caller. */
export const revokeSessionById = async (
  userId: string,
  sessionId: string,
): Promise<void> => {
  const result = await RefreshToken.updateOne(
    { _id: sessionId, user: userId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );

  if (result.matchedCount === 0) {
    throw AppError.notFound('Session not found.', 'session_not_found');
  }
  audit.record(userId, 'session_revoked', { meta: { sessionId } });
};
