import type { Types } from 'mongoose';
import config from '../config/config';
import Device from '../models/device.model';
import type { IDevice } from '../models/device.model';
import EvidenceEnvelope from '../models/evidenceEnvelope.model';
import TheftEpisode from '../models/theftEpisode.model';
import type { ITheftEpisode } from '../models/theftEpisode.model';
import User from '../models/user.model';
import { AppError } from '../utils/appError';
import { isDuplicateKeyError } from '../utils/mongoErrors';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  sha256Hex,
} from '../utils/tokens';
import { entitlementsFor } from './entitlements';
import * as episodeService from './episode.service';
import { integrityVerifier } from './integrity';
import * as partnerEvents from './partnerEvents';
import type { PartnerDeviceView } from './partnerEvents';
import * as partnerService from './partner.service';
import type {
  ClaimInput,
  LinkInput,
  ProvisionRow,
} from '../validation/provisioning.schema';

/**
 * Device-first enrolment (B4), for phones that must protect before anyone
 * signs in - OEM preinstalls, BNPL handsets, fleet phones:
 *
 * 1. PROVISION: a partner system registers handsets by IMEI and gets one
 *    single-use provisioning token per phone, which it bakes into the image
 *    or hands to the phone at the till.
 * 2. CLAIM: the phone trades that token for its ingest token. From here it
 *    uploads evidence and can open an episode; with no owner yet, alerts go
 *    to the partner's recipients.
 * 3. LINK: a person signed in on that phone links it to their account, which
 *    inherits its history.
 */

export type ProvisionStatus = 'provisioned' | 'reissued' | 'claimed';

export interface ProvisionResult {
  deviceId: string;
  imeis: string[];
  serial: string | null;
  status: ProvisionStatus;
  /** Present for provisioned and reissued; shown once, stored hashed. */
  provisioningToken?: string;
}

export interface ClaimResult {
  device: IDevice;
  /** Shown once; only its hash is stored. */
  ingestToken: string;
  /** False when this was the same install retrying a claim. */
  created: boolean;
}

const toResult = (
  device: IDevice,
  status: ProvisionStatus,
  provisioningToken?: string,
): ProvisionResult => ({
  deviceId: device._id.toString(),
  imeis: device.imeis,
  serial: device.serial ?? null,
  status,
  ...(provisioningToken ? { provisioningToken } : {}),
});

/**
 * A handset this partner already provisioned: a factory re-run must not mint
 * a second device for the same phone. Before the claim it gets a fresh token
 * (the old one dies); after it, nothing - that phone already has its own.
 */
const reprovision = async (existing: IDevice): Promise<ProvisionResult> => {
  if (existing.claimedAt) return toResult(existing, 'claimed');
  const provisioningToken = generateOpaqueToken();
  const updated = await Device.updateOne(
    { _id: existing._id, claimedAt: { $exists: false } },
    { $set: { provisioningTokenHash: hashOpaqueToken(provisioningToken) } },
  );
  // claimed between the read and the write: the phone won
  if (updated.modifiedCount === 0) return toResult(existing, 'claimed');
  return toResult(existing, 'reissued', provisioningToken);
};

const findProvisioned = (
  partnerId: Types.ObjectId | string,
  imeis: string[],
): Promise<IDevice | null> =>
  Device.findOne({
    partner: partnerId,
    provisionedAt: { $exists: true },
    imeis: { $in: imeis },
  }).exec();

const provisionOne = async (
  partnerId: string,
  row: ProvisionRow,
): Promise<ProvisionResult> => {
  const existing = await findProvisioned(partnerId, row.imeis);
  if (existing) return reprovision(existing);

  const provisioningToken = generateOpaqueToken();
  try {
    const device = await Device.create({
      partner: partnerId,
      name: row.name ?? `${row.make} ${row.deviceModel}`,
      imeis: row.imeis,
      make: row.make,
      deviceModel: row.deviceModel,
      ...(row.serial ? { serial: row.serial } : {}),
      provisionedAt: new Date(),
      provisioningTokenHash: hashOpaqueToken(provisioningToken),
    });
    return toResult(device, 'provisioned', provisioningToken);
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // a concurrent call provisioned the same handset; converge on its row
    const winner = await findProvisioned(partnerId, row.imeis);
    if (!winner) throw error;
    return reprovision(winner);
  }
};

/** One result per row, in request order. */
export const provision = async (
  partnerId: string,
  rows: ProvisionRow[],
): Promise<ProvisionResult[]> => {
  const results: ProvisionResult[] = [];
  // sequential on purpose: rows are cheap, and a lot of 500 must not open 500
  // concurrent writes against the pool
  for (const row of rows) results.push(await provisionOne(partnerId, row));
  return results;
};

/**
 * What the app binds into its Play Integrity request, so a verdict minted for
 * one claim cannot be replayed on another phone or install.
 */
export const claimRequestHash = (
  provisioningToken: string,
  installId: string,
): string => sha256Hex(`tambo-claim:${provisioningToken}:${installId}`);

const invalidToken = (): AppError =>
  AppError.unauthorized(
    'That provisioning token is not valid.',
    'invalid_provisioning_token',
  );

/**
 * The phone trades its provisioning token for an ingest token. The first
 * claim binds the install; the same install may retry (its response was
 * lost) until the phone is linked, and every retry rotates the ingest token.
 * Any other install is refused, so a provisioning token copied off the
 * factory sheet cannot take over a phone already in someone's hand.
 */
export const claim = async (input: ClaimInput): Promise<ClaimResult> => {
  const device = await Device.findOne({
    provisioningTokenHash: hashOpaqueToken(input.provisioningToken),
  });
  // unknown token and suspended partner answer alike, as at signup
  if (!device?.partner || !(await partnerService.isActive(device.partner))) {
    throw invalidToken();
  }

  if (config.claim.integrity === 'required') {
    if (!input.integrityToken) {
      throw AppError.badRequest(
        'This server requires a Play Integrity token to claim a device.',
        'integrity_required',
      );
    }
    const genuine = await integrityVerifier.verify(
      input.integrityToken,
      claimRequestHash(input.provisioningToken, input.installId),
    );
    if (!genuine) {
      throw AppError.forbidden(
        'The device failed the integrity check.',
        'integrity_failed',
      );
    }
  }

  const installIdHash = hashOpaqueToken(input.installId);
  const ingestToken = generateOpaqueToken();
  const ingestTokenHash = hashOpaqueToken(ingestToken);

  const first = await Device.findOneAndUpdate(
    { _id: device._id, claimedAt: { $exists: false } },
    {
      $set: {
        claimedAt: new Date(),
        claimInstallIdHash: installIdHash,
        ingestTokenHash,
      },
    },
    { new: true },
  );
  if (first) {
    partnerEvents.deviceClaimed(first);
    return { device: first, ingestToken, created: true };
  }

  const retried = await Device.findOneAndUpdate(
    {
      _id: device._id,
      claimInstallIdHash: installIdHash,
      user: { $exists: false },
    },
    { $set: { ingestTokenHash } },
    { new: true },
  );
  if (retried) return { device: retried, ingestToken, created: false };

  throw AppError.conflict(
    'This device has already been claimed.',
    'device_already_claimed',
  );
};

/**
 * A person signed in on the phone takes ownership. Both credentials are
 * required: the session says who, the device token proves they hold this
 * phone's install - a device id alone would let anyone adopt any phone.
 *
 * Refused while an episode is open: whoever is holding a phone that has just
 * failed its unlock threshold is exactly who must not become its owner. The
 * partner resolves the episode first.
 */
export const link = async (
  userId: string,
  deviceId: string,
  tokenDevice: IDevice,
  input: LinkInput,
): Promise<IDevice> => {
  // a token for a different phone is the same answer as an unknown id
  if (!tokenDevice._id.equals(deviceId)) {
    throw AppError.notFound('Device not found.', 'device_not_found');
  }

  const alreadyLinked = (owner: Types.ObjectId): IDevice => {
    if (owner.equals(userId)) return tokenDevice;
    throw AppError.conflict(
      'This device is linked to another account.',
      'device_already_linked',
    );
  };
  if (tokenDevice.user) return alreadyLinked(tokenDevice.user);

  if (await TheftEpisode.exists({ device: tokenDevice._id, status: 'open' })) {
    throw AppError.conflict(
      'This device has an open theft episode, so it cannot be linked until ' +
        'its partner resolves it.',
      'episode_open',
    );
  }

  // linking adds a device to the account, so the plan's allowance applies
  // exactly as it does to enrolment
  const [owner, enrolled] = await Promise.all([
    User.findById(userId).select('plan planExpiresAt'),
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

  const linked = await Device.findOneAndUpdate(
    { _id: tokenDevice._id, user: { $exists: false } },
    {
      $set: {
        user: userId,
        linkedAt: new Date(),
        ...(input.name ? { name: input.name } : {}),
      },
    },
    { new: true },
  );
  if (!linked) {
    // a concurrent link won; same account is a retry, anyone else is refused
    const current = await Device.findById(tokenDevice._id).select('user');
    if (current?.user) return alreadyLinked(current.user);
    throw AppError.notFound('Device not found.', 'device_not_found');
  }

  // the phone's ownerless history (resolved episodes, routine evidence)
  // becomes the owner's: the read paths are all owner-scoped
  await Promise.all([
    TheftEpisode.updateMany(
      { device: linked._id, user: { $exists: false } },
      { $set: { user: linked.user } },
    ),
    EvidenceEnvelope.updateMany(
      { device: linked._id, user: { $exists: false } },
      { $set: { user: linked.user } },
    ),
  ]);

  return linked;
};

export interface PartnerDeviceRead {
  device: PartnerDeviceView;
  openEpisode: { id: string; openedAt: string; openedBy: string } | null;
}

/**
 * One of the partner's phones as the partner may see it: provisioning and
 * claim state, whether someone linked it, and whether an episode is open.
 */
export const partnerDevice = async (
  partnerId: string,
  deviceId: string,
): Promise<PartnerDeviceRead> => {
  const device = await Device.findOne({ _id: deviceId, partner: partnerId });
  if (!device) throw AppError.notFound('Device not found.', 'device_not_found');
  const episode = await episodeService.findOpenForDevice(device._id);
  return {
    device: partnerEvents.partnerDeviceView(device),
    openEpisode: episode
      ? {
          id: episode._id.toString(),
          openedAt: episode.openedAt.toISOString(),
          openedBy: episode.openedBy,
        }
      : null,
  };
};

/**
 * The partner closes an episode on a phone nobody has linked: a false alarm
 * in the shop, or the handset is back in stock. Once a person owns the phone
 * only they can.
 */
export const partnerResolve = async (
  partnerId: string,
  deviceId: string,
): Promise<ITheftEpisode> => {
  const device = await Device.findOne({ _id: deviceId, partner: partnerId });
  if (!device) throw AppError.notFound('Device not found.', 'device_not_found');
  if (device.user) {
    throw AppError.conflict(
      'This device has an owner; only they can resolve its episodes.',
      'device_linked',
    );
  }
  return episodeService.resolveRecovered(device);
};
