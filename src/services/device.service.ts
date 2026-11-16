import type { Types } from 'mongoose';
import Device from '../models/device.model';
import type { IDevice } from '../models/device.model';
import DeviceCommand from '../models/deviceCommand.model';
import TheftEpisode from '../models/theftEpisode.model';
import User from '../models/user.model';
import { AppError } from '../utils/appError';
import { entitlementsFor } from './entitlements';
import * as partnerService from './partner.service';
import * as pushTokenService from './pushToken.service';
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

/** Enrols a device and issues its ingest token in one step. */
export const register = async (
  userId: string,
  input: DeviceInput,
): Promise<EnrolledDevice> => {
  // the plan bounds ENROLMENT only: already-enrolled devices keep protecting
  // and reporting even if the plan later lapses - never brick mid-theft
  const [owner, enrolled] = await Promise.all([
    User.findById(userId).select('plan planExpiresAt partner'),
    Device.countDocuments({ user: userId }),
  ]);
  if (!owner) throw AppError.unauthorized();
  const { maxDevices } = entitlementsFor(owner);
  if (enrolled >= maxDevices) {
    throw AppError.conflict(
      `Your plan allows ${maxDevices} enrolled device${maxDevices === 1 ? '' : 's'}. ` +
        'Remove a device or upgrade to add another.',
      'device_limit',
    );
  }

  const partner = input.partnerCode
    ? (await partnerService.resolveForEnrolment(input.partnerCode))._id
    : owner.partner;

  const ingestToken = generateOpaqueToken();

  const device = await Device.create({
    user: userId,
    name: input.name,
    imeis: input.imeis,
    make: input.make,
    deviceModel: input.deviceModel,
    ...(input.colour ? { colour: input.colour } : {}),
    ...(input.purchaseInfo ? { purchaseInfo: input.purchaseInfo } : {}),
    ...(input.failedUnlockThreshold
      ? { failedUnlockThreshold: input.failedUnlockThreshold }
      : {}),
    ingestTokenHash: hashOpaqueToken(ingestToken),
    ...(partner ? { partner } : {}),
  });

  return { device, ingestToken };
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
  await DeviceCommand.deleteMany({ device: device._id });
  // the app install keeps the owner's alerts; it just stops being this device
  await pushTokenService.detachDevice(device._id);
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

/** Whether the device still holds a live ingest token (and so can poll). */
export const hasIngestToken = async (
  deviceId: Types.ObjectId,
): Promise<boolean> =>
  (await Device.exists({
    _id: deviceId,
    ingestTokenHash: { $exists: true },
  })) !== null;
