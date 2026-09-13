import config from '../config/config';
import PushToken from '../models/pushToken.model';
import type { IPushToken, PushPlatform } from '../models/pushToken.model';
import { isDuplicateKeyError } from '../utils/mongoErrors';

/**
 * The registry of where a user's push notifications go. Deliberately
 * forgiving: registration is an upsert (the app re-registers on every start),
 * unregistering an unknown token is a quiet no-op, and dead tokens are
 * removed when the provider says so - the app never has to reason about
 * registry state.
 */

export interface RegisterInput {
  token: string;
  platform: PushPlatform;
  userAgent?: string | undefined;
}

export const register = async (
  userId: string,
  input: RegisterInput,
): Promise<IPushToken> => {
  // upsert by token, reassigning across accounts (a device that switches
  // users must stop receiving the old account's alerts)
  const update = {
    $set: {
      user: userId,
      platform: input.platform,
      lastSeenAt: new Date(),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    },
  };
  let row: IPushToken;
  try {
    row = await PushToken.findOneAndUpdate({ token: input.token }, update, {
      new: true,
      upsert: true,
    });
  } catch (error) {
    // two concurrent first registrations of the same token: the upsert's
    // find can miss for both, and the losing insert hits the unique index.
    // Registration is documented as always-idempotent, so retry as an update.
    if (!isDuplicateKeyError(error)) throw error;
    const retried = await PushToken.findOneAndUpdate(
      { token: input.token },
      update,
      { new: true },
    );
    if (!retried) throw error;
    row = retried;
  }

  // cap per user, evicting least-recently-seen. Not atomic with the upsert -
  // a racy extra row is a bounded, harmless overage the next register trims.
  const count = await PushToken.countDocuments({ user: userId });
  const excess = count - config.push.maxTokensPerUser;
  if (excess > 0) {
    const stale = await PushToken.find({ user: userId, _id: { $ne: row._id } })
      .sort({ lastSeenAt: 1 })
      .limit(excess)
      .select('_id');
    await PushToken.deleteMany({ _id: { $in: stale.map((doc) => doc._id) } });
  }

  return row;
};

/** Idempotent: removing an unknown/foreign token is a quiet success. */
export const unregister = async (
  userId: string,
  token: string,
): Promise<void> => {
  await PushToken.deleteOne({ user: userId, token });
};

export const activeTokensForUser = async (
  userId: string,
): Promise<string[]> => {
  const rows = await PushToken.find({ user: userId }).select('token');
  return rows.map((row) => row.token);
};

/** Called with the provider's dead-token list after every send. */
export const pruneTokens = async (tokens: string[]): Promise<void> => {
  if (tokens.length === 0) return;
  await PushToken.deleteMany({ token: { $in: tokens } });
};
