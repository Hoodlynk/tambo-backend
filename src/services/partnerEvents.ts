import type { Types } from 'mongoose';
import type { IDevice } from '../models/device.model';
import type {
  SnapshotCamera,
  SnapshotTrigger,
} from '../models/evidenceEnvelope.model';
import type { ITheftEpisode } from '../models/theftEpisode.model';
import * as webhookService from './webhook.service';

/**
 * What a partner hears about its fleet, and the one device shape it sees.
 *
 * Minimal on purpose (the data-processing agreement, decision W7, is still
 * open): no location, no photos, no owner identity, no owner-chosen device
 * name. IMEIs only for phones the partner provisioned, since it supplied them;
 * on a phone a person enrolled under the partner's code they are owner-entered.
 */

export interface PartnerDeviceView {
  id: string;
  imeis: string[] | null;
  serial: string | null;
  make: string;
  deviceModel: string;
  status: IDevice['status'];
  provisioned: boolean;
  claimedAt: string | null;
  linked: boolean;
  linkedAt: string | null;
}

export const partnerDeviceView = (device: IDevice): PartnerDeviceView => ({
  id: device._id.toString(),
  imeis: device.provisionedAt ? device.imeis : null,
  serial: device.serial ?? null,
  make: device.make,
  deviceModel: device.deviceModel,
  status: device.status,
  provisioned: Boolean(device.provisionedAt),
  claimedAt: device.claimedAt?.toISOString() ?? null,
  linked: Boolean(device.user),
  linkedAt: device.linkedAt?.toISOString() ?? null,
});

export const episodeOpened = (device: IDevice, episode: ITheftEpisode): void =>
  webhookService.notify(
    device.partner,
    'episode.opened',
    `episode.opened:${episode._id.toString()}`,
    () => ({
      // the episode opening marks the phone stolen in the same breath
      device: { ...partnerDeviceView(device), status: 'stolen' },
      episode: {
        id: episode._id.toString(),
        openedBy: episode.openedBy,
        openedAt: episode.openedAt.toISOString(),
      },
    }),
  );

export const episodeResolved = (
  device: IDevice,
  episode: ITheftEpisode,
): void =>
  webhookService.notify(
    device.partner,
    'episode.resolved',
    `episode.resolved:${episode._id.toString()}`,
    () => ({
      device: { ...partnerDeviceView(device), status: 'active' },
      episode: {
        id: episode._id.toString(),
        openedAt: episode.openedAt.toISOString(),
        resolvedAt: episode.resolvedAt?.toISOString() ?? null,
        resolution: episode.resolution ?? null,
      },
    }),
  );

export const deviceClaimed = (device: IDevice): void =>
  webhookService.notify(
    device.partner,
    'device.claimed',
    `device.claimed:${device._id.toString()}`,
    () => ({ device: partnerDeviceView(device) }),
  );

export interface ReceivedBurst {
  /** The burst id, or the envelope id of a legacy single photo. */
  key: string;
  burstId: string | null;
  camera: SnapshotCamera;
  trigger: SnapshotTrigger;
}

/**
 * One notice per burst during an episode, however many frames arrive or in
 * how many batches: the key is the burst, so later frames converge on it.
 */
export const snapshotsReceived = (
  device: IDevice,
  episodeId: Types.ObjectId,
  bursts: ReceivedBurst[],
): void => {
  for (const burst of bursts) {
    webhookService.notify(
      device.partner,
      'snapshot.received',
      `snapshot.received:${device._id.toString()}:${burst.key}`,
      () => ({
        device: partnerDeviceView(device),
        episodeId: episodeId.toString(),
        burst: {
          id: burst.burstId,
          camera: burst.camera,
          trigger: burst.trigger,
        },
      }),
    );
  }
};
