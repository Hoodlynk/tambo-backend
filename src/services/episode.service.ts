import type { Types } from 'mongoose';
import Buddy from '../models/buddy.model';
import Device from '../models/device.model';
import type { IDevice } from '../models/device.model';
import TheftEpisode from '../models/theftEpisode.model';
import type {
  EpisodeOpener,
  ITheftEpisode,
} from '../models/theftEpisode.model';
import { AppError } from '../utils/appError';
import { isDuplicateKeyError } from '../utils/mongoErrors';
import * as deliveryService from './delivery.service';
import * as deviceCommandService from './deviceCommand.service';
import * as deviceService from './device.service';
import * as partnerEvents from './partnerEvents';
import { logger } from '../utils/logger';

/**
 * Opens an episode for a device, or returns the one already open - both the
 * owner and the device's own threshold signal may fire around the same theft,
 * and that must converge on ONE episode, not two. The partial unique index on
 * (device, status: open) makes the database the referee: a concurrent second
 * opener loses on the index and is handed the winner's episode.
 *
 * This is the seam evidence ingest (F-B) calls with openedBy: 'device'.
 */
export const openEpisode = async (
  device: IDevice,
  openedBy: EpisodeOpener,
  note?: string,
  reportedBy?: Types.ObjectId | string,
): Promise<{ episode: ITheftEpisode; created: boolean }> => {
  const existing = await TheftEpisode.findOne({
    device: device._id,
    status: 'open',
  });
  if (existing) return { episode: existing, created: false };

  try {
    const episode = await TheftEpisode.create({
      user: device.user,
      device: device._id,
      openedBy,
      openedAt: new Date(),
      ...(note ? { note } : {}),
      ...(reportedBy ? { reportedBy } : {}),
    });

    await Device.updateOne({ _id: device._id }, { $set: { status: 'stolen' } });

    // the F-C first-alert: the owner learns NOW; the pack follows as evidence
    // uploads. Deduped per recipient by the delivery model's unique claim, so
    // converging openers cannot double-alert. Fire-and-forget: alerting must
    // never fail the request that detected the theft.
    void deliveryService.sendFirstAlert(episode, device).catch((error) => {
      logger.error({ err: error }, 'failed to dispatch first alert');
    });
    partnerEvents.episodeOpened(device, episode);

    return { episode, created: true };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // lost the race to a concurrent opener - converge on their episode
      const winner = await TheftEpisode.findOne({
        device: device._id,
        status: 'open',
      });
      if (winner) return { episode: winner, created: false };
    }
    throw error;
  }
};

/** The device's open episode, if any - evidence ingest attaches to it. */
export const findOpenForDevice = (
  deviceId: Types.ObjectId,
): Promise<ITheftEpisode | null> =>
  TheftEpisode.findOne({ device: deviceId, status: 'open' }).exec();

/** Owner marks the device stolen (from another device). Idempotent. */
export const markStolen = async (
  userId: string,
  deviceId: string,
  note?: string,
): Promise<{ episode: ITheftEpisode; created: boolean }> => {
  const device = await deviceService.getOwned(userId, deviceId);
  return openEpisode(device, 'owner', note);
};

/**
 * An accepted buddy reports the owner's phone stolen - for the owner whose
 * only phone IS the stolen one. Only an ACTIVE link authorizes it; a device
 * the caller has no link to 404s exactly like an unknown id, so device ids
 * cannot be probed through this route.
 */
export const reportStolenAsBuddy = async (
  buddyUserId: string,
  deviceId: string,
  note?: string,
): Promise<{ episode: ITheftEpisode; created: boolean }> => {
  const device = await Device.findById(deviceId);
  // an unlinked partner phone has no owner, so nobody can be its buddy
  const linked =
    device?.user &&
    (await Buddy.exists({
      owner: device.user,
      buddy: buddyUserId,
      status: 'active',
    }));
  if (!device || !linked) {
    throw AppError.notFound('Device not found.', 'device_not_found');
  }
  return openEpisode(device, 'buddy', note, buddyUserId);
};

/**
 * Resolves the device's open episode as recovered: back in hand, commands
 * cancelled. Whoever answers for the phone decides - its owner, or for a phone
 * nobody has linked yet, its partner.
 */
export const resolveRecovered = async (
  device: IDevice,
): Promise<ITheftEpisode> => {
  const episode = await TheftEpisode.findOneAndUpdate(
    { device: device._id, status: 'open' },
    {
      $set: {
        status: 'resolved',
        resolution: 'recovered',
        resolvedAt: new Date(),
      },
    },
    { new: true },
  );

  if (!episode) {
    throw AppError.notFound(
      'No open theft episode for this device.',
      'episode_not_found',
    );
  }

  // back in hand: whatever armed the quiet alert belongs to the incident that
  // just closed, so the watchdog starts clean
  await Device.updateOne(
    { _id: device._id },
    {
      $set: { status: 'active' },
      $unset: { suspiciousAt: '', quietAlertedAt: '' },
    },
  );
  await deviceCommandService.cancelForEpisode(episode._id);
  partnerEvents.episodeResolved(device, episode);
  return episode;
};

/** Owner marks the device back in hand; resolves the open episode. */
export const markRecovered = async (
  userId: string,
  deviceId: string,
): Promise<ITheftEpisode> =>
  resolveRecovered(await deviceService.getOwned(userId, deviceId));

export const list = async (
  userId: string,
  deviceId?: string,
): Promise<ITheftEpisode[]> => {
  const filter: Record<string, unknown> = { user: userId };
  if (deviceId) filter.device = deviceId;
  return TheftEpisode.find(filter).sort({ openedAt: -1 }).exec();
};

export const getOwned = async (
  userId: string,
  episodeId: string,
): Promise<ITheftEpisode> => {
  const episode = await TheftEpisode.findOne({ _id: episodeId, user: userId });
  if (!episode)
    throw AppError.notFound('Episode not found.', 'episode_not_found');
  return episode;
};
