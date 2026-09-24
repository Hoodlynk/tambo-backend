import Device from '../models/device.model';
import type { IDevice } from '../models/device.model';
import TheftEpisode from '../models/theftEpisode.model';
import { AppError } from '../utils/appError';
import { isDuplicateKeyError } from '../utils/mongoErrors';
import { generateOpaqueToken, hashOpaqueToken } from '../utils/tokens';
import type {
  DeviceInput,
  DeviceUpdateInput,
} from '../validation/device.schema';

export interface EnrolledDevice {
  device: IDevice;
  /** Shown exactly once; only its hash is stored. */
  ingestToken: string;
  /** False when an installId matched an existing device (token re-issued). */
  created: boolean;
}

/**
 * Loads a device the caller owns, or 404s. Unknown id and someone else's
 * device get the same answer, so ids cannot be probed.
 */
export const getOwned = async (
  userId: string,
  deviceId: string,
): Promise<IDevice> => {
  const device = await Device.findOne({ _id: deviceId, user: userId });
  if (!device) throw AppError.notFound('Device not found.', 'device_not_found');
  return device;
};

/**
 * Re-enrolment of a known install: the phone lost its token (sign-out,
 * reinstall, revoked) and is asking for a new one. The old token dies here.
 * Owner-edited fields (name, IMEIs, threshold) are left alone - the app's
 * auto-generated values must not overwrite what the owner typed.
 */
const reissueForInstall = async (
  userId: string,
  installId: string,
): Promise<EnrolledDevice | null> => {
  const ingestToken = generateOpaqueToken();
  const device = await Device.findOneAndUpdate(
    { user: userId, installId },
    // enrolling is the phone speaking: count it as contact, or a device that
    // was signed out for days would trip the quiet alert before its first
    // check-in
    {
      $set: {
        ingestTokenHash: hashOpaqueToken(ingestToken),
        lastSeenAt: new Date(),
      },
    },
    { new: true },
  );
  return device ? { device, ingestToken, created: false } : null;
};

/**
 * Enrols a device and issues its ingest token in one step. With an
 * installId the call is idempotent per (owner, install), so the app can
 * safely enrol on every sign-in.
 */
export const register = async (
  userId: string,
  input: DeviceInput,
): Promise<EnrolledDevice> => {
  if (input.installId) {
    const existing = await reissueForInstall(userId, input.installId);
    if (existing) return existing;
  }

  const ingestToken = generateOpaqueToken();

  try {
    const device = await Device.create({
      user: userId,
      name: input.name,
      imeis: input.imeis ?? [],
      make: input.make,
      deviceModel: input.deviceModel,
      ...(input.colour ? { colour: input.colour } : {}),
      ...(input.purchaseInfo ? { purchaseInfo: input.purchaseInfo } : {}),
      ...(input.failedUnlockThreshold
        ? { failedUnlockThreshold: input.failedUnlockThreshold }
        : {}),
      // only self-enrolment (from the phone itself) is contact; an owner
      // registering a phone from elsewhere says nothing about it being alive
      ...(input.installId
        ? { installId: input.installId, lastSeenAt: new Date() }
        : {}),
      ingestTokenHash: hashOpaqueToken(ingestToken),
    });

    return { device, ingestToken, created: true };
  } catch (error) {
    // two concurrent enrolments of one install: the loser re-issues against
    // the winner's device rather than failing the sign-in
    if (input.installId && isDuplicateKeyError(error)) {
      const existing = await reissueForInstall(userId, input.installId);
      if (existing) return existing;
    }
    throw error;
  }
};

export const list = (userId: string): Promise<IDevice[]> =>
  Device.find({ user: userId }).sort({ createdAt: -1 }).exec();

export const update = async (
  userId: string,
  deviceId: string,
  input: DeviceUpdateInput,
): Promise<IDevice> => {
  const device = await getOwned(userId, deviceId);

  if (input.name !== undefined) device.name = input.name;
  if (input.imeis !== undefined) device.imeis = input.imeis;
  if (input.make !== undefined) device.make = input.make;
  if (input.deviceModel !== undefined) device.deviceModel = input.deviceModel;
  if (input.colour !== undefined) device.colour = input.colour;
  if (input.purchaseInfo !== undefined)
    device.purchaseInfo = input.purchaseInfo;
  if (input.failedUnlockThreshold !== undefined) {
    device.failedUnlockThreshold = input.failedUnlockThreshold;
  }

  await device.save();
  return device;
};

/**
 * Removal is blocked while a theft episode is open: deleting the device would
 * orphan a live incident (and its evidence, once F-B lands). Resolve first.
 */
export const remove = async (
  userId: string,
  deviceId: string,
): Promise<void> => {
  const device = await getOwned(userId, deviceId);

  if (await TheftEpisode.exists({ device: device._id, status: 'open' })) {
    throw AppError.conflict(
      'This device has an open theft episode. Resolve it before removing the device.',
      'episode_open',
    );
  }

  await TheftEpisode.deleteMany({ device: device._id });
  await device.deleteOne();
};

/**
 * Rotates the ingest token (re-enrolment, or suspected leak). The previous
 * token dies the instant the new hash is written.
 */
export const rotateIngestToken = async (
  userId: string,
  deviceId: string,
): Promise<string> => {
  const device = await getOwned(userId, deviceId);
  const ingestToken = generateOpaqueToken();

  device.ingestTokenHash = hashOpaqueToken(ingestToken);
  try {
    await device.save();
  } catch (error) {
    // astronomically unlikely (token collision), but translate rather than 500
    if (isDuplicateKeyError(error)) {
      throw AppError.conflict(
        'Token rotation collided; try again.',
        'duplicate_key',
      );
    }
    throw error;
  }

  return ingestToken;
};

/** Revokes the ingest token; the device can no longer upload until re-enrolled. */
export const revokeIngestToken = async (
  userId: string,
  deviceId: string,
): Promise<void> => {
  const device = await getOwned(userId, deviceId);
  device.set('ingestTokenHash', undefined); // $unset via mongoose; typed field is optional
  await device.save();
};

/**
 * Resolves an ingest token to its device - the authentication used by
 * evidence upload (F-B). Returns null rather than throwing so the middleware
 * shapes the error uniformly.
 */
export const findByIngestToken = (token: string): Promise<IDevice | null> =>
  Device.findOne({ ingestTokenHash: hashOpaqueToken(token) }).exec();
