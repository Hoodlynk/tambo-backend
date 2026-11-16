import type { Types } from 'mongoose';
import config from '../config/config';
import PushToken from '../models/pushToken.model';
import type { IPushToken, PushPlatform } from '../models/pushToken.model';
import { AppError } from '../utils/appError';
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

/**
 * Upserts by token, reassigning across accounts, then trims the user's set.
 * Two concurrent first registrations of the same token can both miss the
 * upsert's find, and the losing insert hits the unique index. Registration
 * is documented as always-idempotent, so the loser retries the SAME upsert
 * (a plain update could miss again if the row was pruned in between).
 */
const upsert = async (
  userId: string,
  input: RegisterInput,
  extra: {
    device?: Types.ObjectId;
    dropDevice?: boolean;
    /** true: enable alerts; false: only on insert; absent: leave as is. */
    alerts?: boolean;
  },
): Promise<IPushToken> => {
  const update = {
    $set: {
      user: userId,
      platform: input.platform,
      lastSeenAt: new Date(),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      ...(extra.device ? { device: extra.device } : {}),
      ...(extra.alerts === true ? { alerts: true } : {}),
    },
    ...(extra.alerts === false ? { $setOnInsert: { alerts: false } } : {}),
    ...(extra.dropDevice ? { $unset: { device: 1 } } : {}),
  };
  const attempt = (): Promise<IPushToken> =>
    PushToken.findOneAndUpdate({ token: input.token }, update, {
      new: true,
      upsert: true,
    });
  let row: IPushToken;
  try {
    row = await attempt();
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    row = await attempt();
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

/** The owner's app registering for their own alerts (bearer session). */
export const register = async (
  userId: string,
  input: RegisterInput,
): Promise<IPushToken> => {
  // a token moving to a different account is a phone that changed hands:
  // it must stop being the previous owner's enrolled device too, or their
  // remote commands would keep waking a stranger's phone
  const prior = await PushToken.findOne({ token: input.token }).select('user');
  const changedHands = prior !== null && prior.user.toString() !== userId;
  return upsert(userId, input, { dropDevice: changedHands, alerts: true });
};

/**
 * The protected phone registering itself with its device token (B2). Ties
 * the install to the device so remote commands can wake it. It never turns
 * the owner's ALERTS on: the ingest token outlives the owner's sessions, so
 * a phone whose FCM token rotates in a thief's hands must not start hearing
 * the account's alerts. Only a signed-in register (above) does that.
 */
export const registerForDevice = async (
  device: { _id: Types.ObjectId; user?: Types.ObjectId | undefined },
  input: RegisterInput,
): Promise<IPushToken> => {
  // installs belong to an account; an unlinked phone has none yet, and with
  // no owner there is nobody to send it a remote command anyway (B4)
  if (!device.user) {
    throw AppError.conflict(
      'Link this device to an account before registering it for push.',
      'device_not_linked',
    );
  }
  return upsert(device.user.toString(), input, {
    device: device._id,
    alerts: false,
  });
};

/**
 * Sign-out on one install. Idempotent: an unknown/foreign token is a quiet
 * success. An install bound to an enrolled device only loses its alerts -
 * signing out of the app must not stop the owner reaching the phone.
 */
export const unregister = async (
  userId: string,
  token: string,
): Promise<void> => {
  await PushToken.deleteOne({
    user: userId,
    token,
    device: { $exists: false },
  });
  await PushToken.updateOne(
    { user: userId, token, device: { $exists: true } },
    { $set: { alerts: false } },
  );
};

/**
 * Credential rotation / "sign out everywhere": the account's alerts stop
 * reaching every install. Device-bound installs keep their wake-up role -
 * an owner changing their password the minute their phone is stolen is the
 * normal case, and it must not cut off the remote commands they need next.
 */
export const revokeAlertsForUser = async (userId: string): Promise<void> => {
  await PushToken.deleteMany({ user: userId, device: { $exists: false } });
  await PushToken.updateMany(
    { user: userId, device: { $exists: true } },
    { $set: { alerts: false } },
  );
};

/**
 * Every install of a user. `excludeDevice` drops the install registered as
 * that device - the stolen phone, when the alert is about the stolen phone.
 */
export const activeTokensForUser = async (
  userId: string,
  options: { excludeDevice?: Types.ObjectId } = {},
): Promise<string[]> => {
  const rows = await PushToken.find({
    user: userId,
    alerts: { $ne: false },
    ...(options.excludeDevice
      ? { device: { $ne: options.excludeDevice } }
      : {}),
  }).select('token');
  return rows.map((row) => row.token);
};

/** The installs registered as one enrolled device (remote-command wake-ups). */
export const activeTokensForDevice = async (
  deviceId: string | Types.ObjectId,
): Promise<string[]> => {
  const rows = await PushToken.find({ device: deviceId }).select('token');
  return rows.map((row) => row.token);
};

/**
 * Device removed: its installs keep the owner's alerts, minus the binding.
 * One with alerts off was only ever a wake-up target, so it goes entirely.
 */
export const detachDevice = async (deviceId: Types.ObjectId): Promise<void> => {
  await PushToken.deleteMany({ device: deviceId, alerts: false });
  await PushToken.updateMany({ device: deviceId }, { $unset: { device: 1 } });
};

/** Called with the provider's dead-token list after every send. */
export const pruneTokens = async (tokens: string[]): Promise<void> => {
  if (tokens.length === 0) return;
  await PushToken.deleteMany({ token: { $in: tokens } });
};
