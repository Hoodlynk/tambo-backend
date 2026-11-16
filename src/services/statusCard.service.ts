import config from '../config/config';
import type { IDevice } from '../models/device.model';
import EvidenceEnvelope from '../models/evidenceEnvelope.model';
import type { ITheftEpisode } from '../models/theftEpisode.model';
import { brandForDevice } from './clientConfig.service';
import type { ClientConfig } from './clientConfig.service';
import * as deviceCommandService from './deviceCommand.service';
import * as deviceService from './device.service';
import * as episodeService from './episode.service';
import { lastKnownLocation } from './evidenceLocation';
import type { EvidenceLocation } from './evidenceLocation';

/**
 * The status card (B5): the small "is my phone protected?" state a home-screen
 * widget, and later an OEM Zero-screen card, renders. Two views of one phone:
 *
 * - the OWNER's, from another device or the web, says everything, including
 *   an open episode and where the phone was last seen;
 * - the PHONE's own, on its ingest token, never reveals an open episode.
 *   Whoever is holding the phone during one is presumably the thief, and a
 *   card that says "tracking you" is a card that gets the phone switched off.
 *   The phone already learns about the episode from its ingest replies.
 */

/** How often a widget should refresh; the card is cheap, but not free. */
const REFRESH_AFTER_SECONDS = 30 * 60;

export type OwnerCardState = 'protected' | 'stolen' | 'paused';
export type DeviceCardState = 'protected' | 'unlinked';

type CardBrand = ClientConfig['brand'];
type CardLocation = EvidenceLocation & { at: string };

export interface OwnerStatusCard {
  deviceId: string;
  deviceName: string;
  /** stolen: an episode is open. paused: no live ingest token, so no evidence. */
  state: OwnerCardState;
  brand: CardBrand;
  /** Server receipt time of the phone's latest evidence. */
  lastSeenAt: string | null;
  unlockAttempts: { inWindow: number; threshold: number };
  episode: {
    id: string;
    openedAt: string;
    openedBy: ITheftEpisode['openedBy'];
    snapshotBursts: number;
    pendingCommands: number;
    /** Only from evidence around this episode: the card is not a tracker. */
    lastLocation: CardLocation | null;
  } | null;
  refreshAfterSeconds: number;
  generatedAt: string;
}

export interface DeviceStatusCard {
  deviceId: string;
  deviceName: string;
  /** unlinked: a provisioned phone nobody has signed in on yet (B4). */
  state: DeviceCardState;
  brand: CardBrand;
  refreshAfterSeconds: number;
  generatedAt: string;
}

const countBursts = async (episode: ITheftEpisode): Promise<number> => {
  const filter = { episode: episode._id, type: 'PHOTO' as const };
  const [burstIds, legacy] = await Promise.all([
    EvidenceEnvelope.distinct('burstId', {
      ...filter,
      burstId: { $exists: true },
    }),
    // a legacy photo with no burst id is a burst of one
    EvidenceEnvelope.countDocuments({ ...filter, burstId: { $exists: false } }),
  ]);
  return burstIds.length + legacy;
};

const episodeLocation = async (
  device: IDevice,
  episode: ITheftEpisode,
): Promise<CardLocation | null> => {
  const last = await lastKnownLocation(device._id);
  // evidence back-attached to the episode reaches this far before it opened
  const since =
    episode.openedAt.getTime() - config.evidence.backAttachMinutes * 60 * 1000;
  if (!last || last.at.getTime() < since) return null;
  return { ...last.location, at: last.at.toISOString() };
};

const episodeBlock = async (
  device: IDevice,
  episode: ITheftEpisode | null,
): Promise<OwnerStatusCard['episode']> => {
  if (!episode) return null;
  const [snapshotBursts, pendingCommands, lastLocation] = await Promise.all([
    countBursts(episode),
    deviceCommandService.countOutstanding(device._id),
    episodeLocation(device, episode),
  ]);
  return {
    id: episode._id.toString(),
    openedAt: episode.openedAt.toISOString(),
    openedBy: episode.openedBy,
    snapshotBursts,
    pendingCommands,
    lastLocation,
  };
};

export const ownerCard = async (
  userId: string,
  deviceId: string,
): Promise<OwnerStatusCard> => {
  const device = await deviceService.getOwned(userId, deviceId);
  const windowStart = new Date(
    Date.now() - config.evidence.thresholdWindowMinutes * 60 * 1000,
  );

  const [episode, hasToken, latest, inWindow, brand] = await Promise.all([
    episodeService.findOpenForDevice(device._id),
    deviceService.hasIngestToken(device._id),
    EvidenceEnvelope.findOne({ device: device._id })
      .sort({ receivedAt: -1 })
      .select('receivedAt'),
    EvidenceEnvelope.countDocuments({
      device: device._id,
      type: 'UNLOCK_FAILED',
      receivedAt: { $gte: windowStart },
    }),
    brandForDevice(device.partner),
  ]);

  return {
    deviceId: device._id.toString(),
    deviceName: device.name,
    state: episode ? 'stolen' : hasToken ? 'protected' : 'paused',
    brand,
    lastSeenAt: latest?.receivedAt.toISOString() ?? null,
    unlockAttempts: { inWindow, threshold: device.failedUnlockThreshold },
    episode: await episodeBlock(device, episode),
    refreshAfterSeconds: REFRESH_AFTER_SECONDS,
    generatedAt: new Date().toISOString(),
  };
};

/**
 * The phone's own card. Deliberately carries no episode, no attempt count
 * (a thief counting down to the threshold) and no location.
 */
export const deviceCard = async (
  device: IDevice,
): Promise<DeviceStatusCard> => ({
  deviceId: device._id.toString(),
  deviceName: device.name,
  state: device.user ? 'protected' : 'unlinked',
  brand: await brandForDevice(device.partner),
  refreshAfterSeconds: REFRESH_AFTER_SECONDS,
  generatedAt: new Date().toISOString(),
});
